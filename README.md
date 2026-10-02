# ActionRail

ActionRail runs an agent on a customer's accounts. On each tick, it reads new items from a connected account, decides what to do with each item, drafts an action, and puts the action in a queue. A person approves the action. The action waits through an undo window. A dispatcher writes a receipt and performs the action.

ActionRail is a TypeScript library for Node 20 and later. It has no runtime dependencies. It is MIT licensed and published by [Compound Labs](https://thecompound.tech).

```
npm install actionrail
```

## ActionRail sends an action only after a person approves it. A person can undo every approval.

- Every action starts as `held`. In the default mode, `copilot`, a person must approve an action before it leaves the queue.
- Approval does not send the action. Approval sets `release_at = now + undoSeconds` and moves the action to `queued`. Each app sets its own `undoSeconds` in its manifest.
- The dispatcher selects rows only when `status = 'queued' AND release_at <= now`. No code path sends an action before `release_at`.
- Undo conditionally moves an action from `queued` to `cancelled`. The dispatcher conditionally moves a claimed row from `queued` to `sending`. Exactly one move succeeds. Undo either stops the send or reports that it was too late.
- A tenant can switch to `autopilot` after a set number of approvals without edits. An edit before approval does not count. An undo removes one clean approval from that count.
- In `autopilot`, an action waits for a person when a hold rule fires. It also waits when its amount exceeds the tenant's threshold or when a step uses its fallback after leaving the model path.
- Gates run in the pass, at approval, and in the dispatcher on current data. A gate that stops an item blocks its action at any of those three points.

## The dispatcher writes the receipt before it sends the action.

- The dispatcher writes a `receipt` row to the ledger before it calls the action connector.
- If the dispatcher cannot write the receipt, it abandons the send and moves the row back to `queued` for the next tick.
- A refused write is final. The dispatcher records the refusal and never retries it.
- A later tick marks a row left in `sending` by a crashed tick as `failed`. The dispatcher never resends that row by itself.
- Every step writes a ledger row with its evidence. The evidence includes what the step read, the label, the quotes behind the label, the draft, the hold reasons, the approval, the receipt, and the provider's own id for what it did.

## Caps per tenant

- `inferencePerDay` limits model calls for each tenant per UTC day. ActionRail counts each call before making it. No model step runs after the cap is reached.
- `actionsPerDay` limits sends for each tenant per UTC day. The dispatcher counts sends again at send time. It moves over-cap rows back to `held`.
- `perThread` limits actions in one thread. A thread at its cap sends the action to a person.
- `perPass` limits the items that one pass reads. The watermark resumes the remaining items on the next pass.

## Bring your own model

Model steps use one provider interface. ActionRail ships drivers for OpenAI, Anthropic, Gemini, and any OpenAI-compatible base URL. An OpenAI-compatible base URL can point to a local model. The drivers use `fetch` and read no key from the environment. You pass the key.

```ts
import { createProvider } from "actionrail";

const openai = createProvider({ provider: "openai", model: "gpt-4.1-mini", apiKey: myKey });
const claude = createProvider({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: myKey });
const gemini = createProvider({ provider: "gemini", model: "gemini-2.5-flash", apiKey: myKey });
const local = createProvider({ provider: "openai-compatible", model: "llama3.1", baseURL: "http://localhost:11434/v1" });
```

A step retries once when its output does not parse. A step retries once after a short wait when a rate limit or provider-side error occurs. After the retry, the step uses its fallback or sends the item to a person. A step with no provider configured follows the same path. An app that uses only rule and template steps needs no provider.

## The loop

One pass runs for one tenant per tick.

1. The runner checks the tenant's plan. An unentitled tenant gets no pass.
2. The runner skips the demo tenant. If the demo lookup fails, the pass stops.
3. The runner pulls each source from its watermark onward. It stores each item once under (tenant, provider, external id).
4. The runner runs the hard gates. A stop is final for that item.
5. The runner checks the daily model cap and then classifies the item.
6. The runner decides `stop`, `ignore`, `handoff`, `schedule`, or `stage`.
7. For `stage`, the runner drafts the action and runs the draft checks. A refused draft goes to a person.
8. The runner routes the action to `held` or to `queued` behind the undo window.
9. The runner applies the thread's state transition and writes the ledger rows.
10. The runner moves the watermark to the newest item recorded after it writes the batch. If any source failed, the runner moves no watermark.

The dispatcher runs across all tenants. It claims due rows, checks each plan again, runs the gates again on current data, counts the caps again, writes the receipt, performs the action, and records the result.

## The manifest

An app gives the runner one manifest. The runner reads no other app data.

```ts
import { allow, createRunner, defineManifest, MemoryStore, mailboxSource, mailboxReplyAction, stop } from "actionrail";

const manifest = defineManifest({
  app: "helpdesk",
  billing: { gate: "subscription", isEntitled: (tenantId) => plans.isActive(tenantId), demoEmail: "demo@example.com" },
  tenants: { list: () => accounts.ids(), idForEmail: (email) => accounts.idFor(email) },
  schedule: { pass: "10 5 * * *", dispatch: "*/5 * * * *" },
  sources: [mailboxSource(openMailbox)],
  actions: { reply: mailboxReplyAction(openMailbox) },
  gates: [(msg) => (msg.fromEmail ? allow() : stop("no sender to reply to"))],
  steps: { classify, decide, draft, checkDraft: [noInventedRefunds] },
  approval: { defaultMode: "copilot", alwaysHold: [], cleanApprovalsToUnlock: 10, undoSeconds: 120 },
  caps: { inferencePerDay: 200, actionsPerDay: 120, perThread: 3, perPass: 60 },
  state: { initial: "open", transition: (state, event) => nextState(state, event) },
  ledger: { events: "helpdesk_events", artifacts: "helpdesk_drafts", runs: "helpdesk_runs" },
});

const runner = createRunner({ store: new MemoryStore(), provider: gemini });
await runner.runPass(manifest, tenantId);
await runner.approve(manifest, tenantId, artifactId);
await runner.undo(manifest, tenantId, artifactId);
await runner.runDispatch(manifest);
```

`defineManifest` refuses a manifest with no undo window, a cap below 1, no action connector, or a schedule that is not a five-field cron.

## Steps

`classify` and `draft` each accept one of three step kinds:

- A model step has a `capability` name, a `build` function that returns the prompt, a `parse` function that validates the JSON, and an optional `fallback`.
- A rule step is a deterministic function with no model call.
- A template step builds fixed text from the item.

`decide` always takes the item, its classification, the thread state, and the tenant's policy as inputs.

ActionRail ships rule building blocks for apps that require deterministic core logic:

- `hardStop(codes, read)` stops any item carrying one of the codes, with no override.
- `ruleTable(rules)` scores an item and records the rule behind every point.
- `firstMatch(rules, otherwise)` labels an item with the first matching rule.
- `withinTolerance(a, b, { abs, pct })` compares two figures for a three-way match.
- `decideByLabel({ labelOf, handoff, ignore })` sends some labels to a person, ignores others, and drafts the rest.

## Connectors

A source connector lists items since a watermark. An action connector performs one approved action. Both interfaces allow any API to sit behind them.

ActionRail ships a Microsoft Graph mailbox connector:

- The mailbox connector needs a grant with `Mail.Send` and `Mail.ReadWrite`. A narrower grant opens no mailbox.
- The mailbox connector refreshes the access token when under five minutes remain, using the Entra app that minted it. It keeps the app marker, the scopes, and the address across every rotation.
- The mailbox connector reads unread mail after the watermark, oldest first, as plain text with the quoted history removed.
- The mailbox connector replies inside the customer's own thread with createReply, then PATCH, then send, and marks the answered message read.
- A failed read throws. The runner keeps the watermark and does not treat the outage as an empty result.

You keep the tokens in your own table behind the `GraphTokenStore` interface, encrypted at rest.

`FakeMailbox` implements the same interface in memory. The tests and the example run the whole loop against it.

## Stores

`MemoryStore` keeps everything in the process. It backs the tests and the examples.

`SqlStore` writes to Postgres or SQLite through a query function you pass in. ActionRail has no database driver dependency.

```ts
import { Pool } from "pg";
import { SqlStore, pgQuery } from "actionrail";

const store = new SqlStore({ dialect: "postgres", query: pgQuery(new Pool({ connectionString })) }).scope(manifest.ledger);
await store.migrate();
```

The test suite runs every runner test against the memory store, SQLite, and Postgres.

## Scheduling and cron auth

ActionRail schedules nothing by itself. Your scheduler calls the pass and the dispatcher. `runner.tick(manifests, "pass" | "dispatch")` runs every manifest whose cron matches the current minute in UTC.

`cronRoute(request, run)` guards a tick route. It answers 401 unless the request carries `Authorization: Bearer <CRON_SECRET>`. It answers 401 for every caller while the secret is unset. The comparison hashes both sides first and uses a constant-time check.

## Scaffold an app

```
npx actionrail new-app my-agent --app console
npx actionrail new-app my-agent --app simple
npx actionrail new-app my-agent --app both
```

The command writes a Next.js app wired to the runner. The app includes cron routes, queue routes for approve, undo, reject, and mode, and a starter manifest. In development, it runs against an in-memory mailbox, so you can deliver a sample message, run a pass, approve, and dispatch on your machine.

- `console` shows the queue, the ledger, and today's caps on one dense screen.
- `simple` shows one draft at a time and places details behind disclosures.
- `both` adds a welcome dialog that explains the agent and a footer switch between the two views.

In production, the starter refuses every account and every queue request until you wire your sign-in and plan check.

## Worked example: TriageDesk

`examples/triagedesk` expresses the TriageDesk agent as a manifest. TriageDesk reads a small team's shared inbox overnight and leaves a queue of drafted replies for the morning.

- TriageDesk has eleven categories. Complaints, legal mail, and cancellations go to a person with no draft. TriageDesk records automated mail and spam and never answers them.
- Quotes behind a label must appear in the message. The parser drops a quote that the message does not contain.
- The system refuses a draft that promises a refund, a credit, a discount, a date, or a guarantee that the message and the saved answers do not contain.
- ActionRail limits each thread to three replies, each day to 120 sends and 200 model calls, and sets a 120-second undo window.

```
npm run example
GEMINI_API_KEY=your-key node examples/triagedesk/run.mjs --gemini
```

The first command uses a scripted stub model and makes no network call. The second runs the same loop on Gemini. Both write the pass summary, the queue, the sent mail and the ledger to `examples/triagedesk/out/`.

A video tutorial on YouTube builds this example step by step: https://youtu.be/wDj944bmHm0. It installs ActionRail, reads the manifest, runs the example and reads its output. It then shows which parts to change to build a product like FetchDue, and it scaffolds an app with `--app console`.

## Tests

```
npm test
```

The tests use a stub provider and make no network call. When `GEMINI_API_KEY` is set, `test/live-gemini.test.mjs` runs the example on Gemini and otherwise skips it. No test reads a paid provider's key.

`node scripts/scrub-gate.mjs` fails the build when the repository carries a key-shaped string, a private address or handle, or bot-detection bypass code. CI runs the command before the tests.

## License

MIT. Copyright 2026 Compound Labs.
