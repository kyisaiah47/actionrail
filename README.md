# ActionRail

ActionRail runs an agent that acts on a customer's accounts. Each tick it reads new items from a connected account, decides what to do with each one, drafts an action, and leaves the action in a queue. A person approves the action. The action waits out an undo window. A dispatcher writes a receipt and then performs it.

ActionRail is a TypeScript library for Node 20 and later. It has no runtime dependencies. It is MIT licensed and published by [Compound Labs](https://thecompound.tech).

```
npm install actionrail
```

## Nothing is sent without approval, and every approval can be undone

- Every action starts as `held`. In the default mode, `copilot`, nothing leaves the queue until a person approves it.
- Approve does not send. It stamps `release_at = now + undoSeconds` and moves the action to `queued`. Each app sets its own `undoSeconds` in its manifest.
- The dispatcher selects only rows where `status = 'queued' AND release_at <= now`. No code path sends before `release_at`.
- Undo is a conditional move from `queued` to `cancelled`. The dispatcher claims a row with a conditional move from `queued` to `sending`. Exactly one of the two wins, so an undo either stops the send or reports that it was too late.
- Autopilot is earned. A tenant can switch to `autopilot` only after a set number of approvals without an edit. An edit before approval does not count, and an undo takes a clean approval back.
- In autopilot, an action still waits for a person when a hold rule fires, when its amount is over the tenant's threshold, or when a step fell back from the model to a fallback.
- Gates run three times: in the pass, at approval, and again in the dispatcher on current data. A gate that stops an item blocks its action at any of the three points.

## The receipt is written before the send

- The dispatcher writes a `receipt` row to the ledger before it calls the action connector.
- If the receipt cannot be written, the send is abandoned and the row goes back to `queued` for the next tick.
- A refused write is final. The dispatcher records the refusal and never retries it.
- A row left in `sending` by a crashed tick is marked `failed` by a later tick. It is never resent by itself.
- Every step writes a ledger row with its evidence: what was read, the label, the quotes behind the label, the draft, the hold reasons, the approval, the receipt and the provider's own id for what it did.

## Caps per tenant

- `inferencePerDay` limits model calls per tenant per UTC day. Each call is counted before it is made, and no model step runs once the cap is reached.
- `actionsPerDay` limits sends per tenant per UTC day. The dispatcher counts again at send time and moves over-cap rows back to `held`.
- `perThread` limits actions in one thread. A thread at its cap goes to a person.
- `perPass` limits the items one pass reads. The watermark resumes the rest on the next pass.

## Bring your own model

Model steps go through one provider interface. ActionRail ships drivers for OpenAI, Anthropic, Gemini and any OpenAI-compatible base URL, which covers a local model. The drivers use `fetch` and read no key from the environment. You pass the key.

```ts
import { createProvider } from "actionrail";

const openai = createProvider({ provider: "openai", model: "gpt-4.1-mini", apiKey: myKey });
const claude = createProvider({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: myKey });
const gemini = createProvider({ provider: "gemini", model: "gemini-2.5-flash", apiKey: myKey });
const local = createProvider({ provider: "openai-compatible", model: "llama3.1", baseURL: "http://localhost:11434/v1" });
```

A step whose output does not parse is retried once. A rate limit or a provider-side error is retried once after a short wait. After that the step uses its fallback, or the item goes to a person. A step with no provider configured does the same. An app built only from rule and template steps needs no provider at all.

## The loop

One pass runs for one tenant per tick:

1. Check the tenant's plan. An unentitled tenant gets no pass.
2. Skip the demo tenant. If the demo lookup fails, the pass stops.
3. Pull every source since its watermark. Each item is stored once, on (tenant, provider, external id).
4. Run the hard gates. A stop is final for that item.
5. Check the daily model cap, then classify.
6. Decide: `stop`, `ignore`, `handoff`, `schedule` or `stage`.
7. For `stage`, draft, then run the draft checks. A refused draft goes to a person.
8. Route the action to `held`, or to `queued` behind the undo window.
9. Apply the thread's state transition and write the ledger rows.
10. Move the watermark to the newest item recorded, after the batch is written. If any source failed, no watermark moves.

The dispatcher runs across all tenants. It claims due rows, checks the plan again, re-runs the gates on current data, counts the caps again, writes the receipt, performs the action and records the result.

## The manifest

An app hands the runner one manifest. The runner reads nothing else about the app.

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

`defineManifest` refuses a manifest with no undo window, a cap below 1, no action connector or a schedule that is not a five-field cron.

## Steps

`classify` and `draft` each take one of three step kinds:

- A model step has a `capability` name, a `build` function that returns the prompt, a `parse` function that validates the JSON, and an optional `fallback`.
- A rule step is a deterministic function with no model call.
- A template step builds a fixed text from the item.

`decide` is always a plain function of the item, its classification, the thread state and the tenant's policy.

ActionRail ships rule building blocks for apps whose core must stay deterministic:

- `hardStop(codes, read)` is a gate that stops any item carrying one of the codes, with no override.
- `ruleTable(rules)` scores an item and records the rule behind every point.
- `firstMatch(rules, otherwise)` labels an item by the first rule that matches.
- `withinTolerance(a, b, { abs, pct })` compares two figures for a three-way match.
- `decideByLabel({ labelOf, handoff, ignore })` sends some labels to a person, ignores others and drafts the rest.

## Connectors

A source connector lists items since a watermark. An action connector performs one approved action. Both are small interfaces, so any API can sit behind them.

ActionRail ships a Microsoft Graph mailbox:

- It needs a grant with `Mail.Send` and `Mail.ReadWrite`. A narrower grant opens no mailbox.
- It refreshes the access token when under five minutes remain, against the Entra app that minted it, and keeps the app marker, the scopes and the address across every rotation.
- It reads unread mail after the watermark, oldest first, as plain text with the quoted history removed.
- It replies inside the customer's own thread with createReply, then PATCH, then send, and marks the answered message read.
- A failed read throws, so the runner keeps the watermark instead of reading an outage as a quiet night.

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

The test suite runs every runner test against the memory store, SQLite and Postgres.

## Scheduling and cron auth

ActionRail schedules nothing by itself. Your scheduler calls the pass and the dispatcher. `runner.tick(manifests, "pass" | "dispatch")` runs every manifest whose cron matches the current minute in UTC.

`cronRoute(request, run)` guards a tick route. It answers 401 unless the request carries `Authorization: Bearer <CRON_SECRET>`, and it answers 401 for every caller while the secret is unset. The compare hashes both sides first and uses a constant-time check.

## Scaffold an app

```
npx actionrail new-app my-agent --app console
npx actionrail new-app my-agent --app simple
npx actionrail new-app my-agent --app both
```

The command writes a Next.js app wired to the runner: the cron routes, the queue routes for approve, undo, reject and mode, and a starter manifest. In development it runs against an in-memory mailbox, so you can deliver a sample message, run a pass, approve and dispatch on your machine.

- `console` is a dense screen with the queue, the ledger and today's caps.
- `simple` shows one draft at a time, with details behind disclosures.
- `both` adds a welcome dialog that explains the agent and a footer switch between the two views.

In production the starter refuses every account and every queue request until you wire your sign-in and your plan check.

## Worked example: TriageDesk

`examples/triagedesk` is the TriageDesk agent expressed as a manifest. TriageDesk reads a small team's shared inbox overnight and leaves a queue of drafted replies for the morning.

- Eleven categories. Complaints, legal mail and cancellations go to a person with no draft. Automated mail and spam are recorded and never answered.
- Quotes behind a label must appear in the message, or they are dropped.
- A draft that promises a refund, a credit, a discount, a date or a guarantee that the message and the saved answers do not contain is refused.
- Three replies per thread, 120 sends and 200 model calls per day, and a 120 second undo window.

```
npm run example
GEMINI_API_KEY=your-key node examples/triagedesk/run.mjs --gemini
```

The first command uses a scripted stub model and makes no network call. The second runs the same loop on Gemini.

## Tests

```
npm test
```

The tests use a stub provider and make no network call. `test/live-gemini.test.mjs` runs the example on Gemini when `GEMINI_API_KEY` is set and skips otherwise. No test reads a paid provider's key.

`node scripts/scrub-gate.mjs` fails the build if the repository carries a key-shaped string, a private address or handle, or bot-detection bypass code. CI runs it before the tests.

## License

MIT. Copyright 2026 Compound Labs.
