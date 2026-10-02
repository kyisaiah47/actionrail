// THE RUNNER. One pass per tenant per tick, one dispatcher across all tenants, and the approval
// and undo calls a queue UI makes. It implements the shared loop from the engine spec, sections
// 3 and 4, in one place.
//
// The rules it enforces for every manifest:
//   - gates run in the pass, in approve and in the dispatcher;
//   - no ModelStep runs once the tenant's daily model cap is reached, and each call is counted
//     before it is made;
//   - a fallback result only ever routes to `held`;
//   - `release_at` is a column the dispatcher's query predicates on, so nothing is sent before it;
//   - the receipt is written before the action connector is called, and a failed receipt write
//     abandons the send;
//   - a refused write is never retried;
//   - every step writes a ledger row with its evidence;
//   - the watermark moves to the newest item recorded, after the batch is written, and does not
//     move at all when any source failed.

import { autopilotUnlocked, route, type Mode } from "./autonomy.js";
import { addSeconds, capReached, utcDayStart } from "./caps.js";
import { parseModelJson } from "./json.js";
import {
  isModelStep,
  type ActionResult,
  type AgentManifest,
  type AnyManifest,
  type Decision,
  type Evidence,
  type GateCtx,
  type GatePhase,
  type GateVerdict,
  type SourceConnector,
  type StateEvent,
  type Step,
} from "./manifest.js";
import { isTransient, type ModelProvider } from "./providers/types.js";
import { cronMatches } from "./schedule.js";
import type { ArtifactRecord, NewEvent, Store, TenantSettings } from "./store/types.js";

export interface RunnerOptions {
  store: Store;
  /** The user's model. Optional: a manifest with only rule and template steps needs none. */
  provider?: ModelProvider | null;
  /** The clock for calls that are not handed a `now`. */
  clock?: () => Date;
  /** Artifacts one dispatcher tick moves. Small, so a queue drains over several ticks. */
  dispatchBatch?: number;
  /** A pass that started longer ago than this is treated as dead. */
  passLeaseMs?: number;
  /** A row claimed longer ago than this is failed by the next dispatch, never resent. */
  staleClaimMs?: number;
  /** Where the runner reports errors it recovers from. */
  log?: (message: string, err?: unknown) => void;
  /** The wait before the one retry after a rate limit or a provider-side error. */
  retryDelayMs?: number;
}

export interface PassSummary {
  app: string;
  tenantId: string;
  runId: string | null;
  ok: boolean;
  /** Why the pass did not run or did not finish. */
  reason?: "unentitled" | "demo" | "demo-lookup-failed" | "already-running" | string;
  unentitled: number;
  pulled: number;
  recorded: number;
  duplicates: number;
  stopped: number;
  ignored: number;
  handedOff: number;
  held: number;
  queued: number;
  inferenceCalls: number;
  watermarks: Record<string, { before: string | null; after: string | null }>;
}

export interface DispatchSummary {
  app: string;
  ok: boolean;
  reason?: string;
  due: number;
  claimed: number;
  sent: number;
  failed: number;
  blocked: number;
  /** Over a cap, so moved back to `held` for a person. */
  releasedToHeld: number;
  /** Left `queued` for a later tick: unentitled, demo, a failed refresh or a failed receipt. */
  leftQueued: number;
  /** Lost the claim to an undo or another tick. */
  lostClaim: number;
  /** Stuck in `sending` from an earlier tick and failed now. */
  reclaimed: number;
}

export interface TickResult {
  app: string;
  job: "pass" | "dispatch";
  due: boolean;
  passes?: PassSummary[];
  dispatch?: DispatchSummary;
  error?: string;
}

export interface Overview {
  settings: TenantSettings;
  unlocksAutopilotAt: number;
  sentToday: number;
  inferenceToday: number;
  caps: AnyManifest["caps"];
  undoSeconds: number;
  artifacts: ArtifactRecord[];
  events: Awaited<ReturnType<Store["listEvents"]>>;
}

/** A refusal from approve, undo, reject or setMode, with an HTTP status a route can return. */
export class RunnerError extends Error {
  readonly code: "not_found" | "conflict" | "unentitled" | "demo" | "demo_lookup_failed" | "gate_stopped" | "locked";
  readonly status: number;
  constructor(code: RunnerError["code"], status: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.status = status;
  }
}

type StepOutcome<O> =
  | { ok: true; value: O; fallback: boolean; via: string; note?: string }
  | { ok: false; reason: string; capped: boolean };

const PASS_LEASE_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 30 * 60 * 1000;
const DISPATCH_BATCH = 20;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runGates<Item>(
  gates: Array<(item: Item, ctx: GateCtx) => GateVerdict>,
  item: Item,
  ctx: GateCtx,
): Extract<GateVerdict, { stop: true }> | null {
  for (const gate of gates) {
    let v: GateVerdict;
    try {
      v = gate(item, ctx);
    } catch (err) {
      // A gate that throws stops the item. A broken check never lets an action through.
      return { stop: true, reason: `a gate threw: ${message(err)}` };
    }
    if (v.stop) return v;
  }
  return null;
}

export interface Runner {
  runPass<I, A extends { kind: string }, S extends string, C>(m: AgentManifest<I, A, S, C>, tenantId: string, now?: Date): Promise<PassSummary>;
  runDispatch(m: AnyManifest, now?: Date): Promise<DispatchSummary>;
  approve<A extends { kind: string }>(
    m: AgentManifest<any, A, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    tenantId: string,
    artifactId: string,
    edits?: Partial<Omit<A, "kind">>,
    now?: Date,
  ): Promise<{ releaseAt: string }>;
  undo(m: AnyManifest, tenantId: string, artifactId: string, now?: Date): Promise<boolean>;
  reject(m: AnyManifest, tenantId: string, artifactId: string, now?: Date): Promise<boolean>;
  setMode(m: AnyManifest, tenantId: string, mode: Mode, now?: Date): Promise<TenantSettings>;
  settings(m: AnyManifest, tenantId: string): Promise<TenantSettings>;
  overview(m: AnyManifest, tenantId: string, now?: Date): Promise<Overview>;
  /** Runs every manifest whose cron for `job` matches `now`. */
  tick(manifests: AnyManifest[], job: "pass" | "dispatch", now?: Date): Promise<TickResult[]>;
}

export function createRunner(opts: RunnerOptions): Runner {
  const clock = opts.clock ?? (() => new Date());
  const provider = opts.provider ?? null;
  const batch = opts.dispatchBatch ?? DISPATCH_BATCH;
  const passLeaseMs = opts.passLeaseMs ?? PASS_LEASE_MS;
  const staleClaimMs = opts.staleClaimMs ?? STALE_CLAIM_MS;
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const log = opts.log ?? ((msg: string, err?: unknown) => console.error(`[actionrail] ${msg}`, err ?? ""));

  const storeFor = (m: AnyManifest): Store => opts.store.scope?.(m.ledger) ?? opts.store;

  async function settingsFor(m: AnyManifest, store: Store, tenantId: string): Promise<TenantSettings> {
    const saved = await store.getTenantSettings(m.app, tenantId);
    return saved ?? { mode: m.approval.defaultMode, cleanApprovals: 0, holdOverThreshold: null };
  }

  async function entitled(m: AnyManifest, tenantId: string): Promise<boolean> {
    try {
      return (await m.billing.isEntitled(tenantId)) === true;
    } catch (err) {
      log(`${m.app}: the entitlement check threw for ${tenantId}; treating the tenant as unentitled`, err);
      return false;
    }
  }

  /** Re-reads an item from its source when the source can, so gates see current data. */
  async function currentItem(
    m: AnyManifest,
    providerName: string,
    externalId: string,
    stored: unknown,
    tenantId: string,
  ): Promise<{ item: unknown } | { gone: true } | { error: string }> {
    const source = (m.sources as SourceConnector<unknown>[]).find((s) => s.provider === providerName);
    if (!source?.refresh) return { item: stored };
    try {
      const fresh = await source.refresh(tenantId, externalId);
      return fresh === null ? { gone: true } : { item: fresh };
    } catch (err) {
      return { error: message(err) };
    }
  }

  async function applyState(
    m: AnyManifest,
    store: Store,
    tenantId: string,
    threadKey: string,
    current: string,
    e: StateEvent,
    nowIso: string,
    ev: NewEvent[],
    base: Omit<NewEvent, "kind" | "title">,
  ): Promise<string> {
    let next: string | null;
    try {
      next = m.state.transition(current, e);
    } catch (err) {
      log(`${m.app}: state.transition threw on ${e.type}`, err);
      next = null;
    }
    if (next === null || next === current) return current;
    await store.saveThreadState(m.app, tenantId, threadKey, next, nowIso);
    ev.push({ ...base, kind: "state", title: `Thread moved from ${current} to ${next}`, evidence: [{ kind: "state", label: `on ${e.type}` }] });
    return next;
  }

  /* --------------------------------- the pass --------------------------------- */

  async function runPass<I, A extends { kind: string }, S extends string, C>(
    m: AgentManifest<I, A, S, C>,
    tenantId: string,
    now: Date = clock(),
  ): Promise<PassSummary> {
    const store = storeFor(m);
    const app = m.app;
    const nowIso = now.toISOString();
    const summary: PassSummary = {
      app,
      tenantId,
      runId: null,
      ok: false,
      unentitled: 0,
      pulled: 0,
      recorded: 0,
      duplicates: 0,
      stopped: 0,
      ignored: 0,
      handedOff: 0,
      held: 0,
      queued: 0,
      inferenceCalls: 0,
      watermarks: {},
    };
    const tenantEvent = (kind: string, title: string, detail: string | null, evidence: Evidence[]): NewEvent => ({
      app,
      tenantId,
      kind,
      title,
      detail,
      evidence,
      at: nowIso,
    });

    // 1. Entitlement first, so an unpaid tenant costs one lookup and reaches no source and no model.
    if (!(await entitled(m, tenantId))) {
      await store.appendEvents([
        tenantEvent("unentitled", "No active plan, so the pass did not run", null, [{ kind: "rule", label: "the agent runs only for an entitled account" }]),
      ]);
      return { ...summary, unentitled: 1, reason: "unentitled" };
    }

    // 2. The demo tenant is skipped by id. A failed lookup stops the pass.
    let demoId: string | null;
    try {
      demoId = await m.tenants.idForEmail(m.billing.demoEmail);
    } catch (err) {
      log(`${app}: the demo lookup failed; the pass stops`, err);
      await store.appendEvents([
        tenantEvent("stopped", "The demo account lookup failed, so the pass stopped", message(err), [
          { kind: "rule", label: "a pass never runs without knowing which account is the demo" },
        ]),
      ]);
      return { ...summary, reason: "demo-lookup-failed" };
    }
    if (demoId !== null && demoId === tenantId) {
      await store.appendEvents([
        tenantEvent("skipped", "The demo account never gets a pass", null, [{ kind: "rule", label: "the demo shows seeded rows and never reaches a source or a model" }]),
      ]);
      return { ...summary, reason: "demo" };
    }

    const runId = await store.startRun(app, tenantId, nowIso, new Date(now.getTime() - passLeaseMs).toISOString());
    if (!runId) return { ...summary, reason: "already-running" };
    summary.runId = runId;

    try {
      const settings = await settingsFor(m, store, tenantId);
      const spent = { used: await store.countInferenceSince(app, tenantId, utcDayStart(now)) };
      const policy = { mode: settings.mode, undoSeconds: m.approval.undoSeconds, caps: m.caps };
      const budget = m.caps.perPass ?? Number.POSITIVE_INFINITY;
      const limit = Number.isFinite(budget) ? budget : 100;

      async function runStep<In, Out>(step: Step<In, Out>, input: In, label: string): Promise<StepOutcome<Out>> {
        if (step.kind === "rule" || step.kind === "template") {
          try {
            const v = step.kind === "rule" ? step.run(input) : step.render(input);
            return v === null || v === undefined
              ? { ok: false, reason: `the ${label} ${step.kind} returned nothing`, capped: false }
              : { ok: true, value: v, fallback: false, via: step.kind };
          } catch (err) {
            return { ok: false, reason: `the ${label} ${step.kind} threw: ${message(err)}`, capped: false };
          }
        }
        if (!isModelStep(step)) return { ok: false, reason: `the ${label} step has no kind`, capped: false };

        let reason = "no model provider is configured";
        let capped = false;
        if (provider) {
          const prompt = step.build(input);
          for (let attempt = 0; attempt < 2; attempt++) {
            // The cap is checked before every call, the retry included, and the call is counted
            // before it is made: a call that throws has still been made.
            if (capReached(spent.used, m.caps.inferencePerDay)) {
              capped = true;
              reason = `the daily model cap of ${m.caps.inferencePerDay} is reached`;
              break;
            }
            spent.used += 1;
            summary.inferenceCalls += 1;
            await store.recordInference({
              app,
              tenantId,
              capability: step.capability,
              provider: provider.name,
              model: step.model ?? provider.model,
              at: nowIso,
            });
            let text: string;
            let model: string;
            try {
              const res = await provider.complete({ ...prompt, model: step.model, json: true });
              text = res.text;
              model = res.model;
            } catch (err) {
              reason = `the model call failed: ${message(err)}`;
              // One more try after a rate limit or a provider-side error. Any other failure is final.
              if (attempt === 0 && isTransient(err)) {
                await new Promise((r) => setTimeout(r, retryDelayMs));
                continue;
              }
              break;
            }
            const json = parseModelJson(text);
            const out = json ? step.parse(json, input) : null;
            if (out !== null && out !== undefined) return { ok: true, value: out, fallback: false, via: `${provider.name} ${model}` };
            reason = json ? "the model's JSON did not fit the step" : "the model returned no JSON object";
          }
        }
        if (step.fallback) {
          try {
            return { ok: true, value: step.fallback(input), fallback: true, via: "fallback", note: reason };
          } catch (err) {
            return { ok: false, reason: `${reason}; the fallback threw: ${message(err)}`, capped };
          }
        }
        return { ok: false, reason, capped };
      }

      // 3. Pull every source since its watermark.
      interface Pulled {
        source: SourceConnector<I>;
        items: I[];
        next: string | null;
        before: string | null;
        lastCursor: string | null;
        visitedAll: boolean;
      }
      const pulls: Pulled[] = [];
      let anyFailed = false;
      for (const source of m.sources) {
        const before = await store.getWatermark(app, tenantId, source.provider);
        summary.watermarks[source.provider] = { before, after: before };
        let res: Awaited<ReturnType<typeof source.listSince>>;
        try {
          res = await source.listSince(tenantId, before, { limit });
        } catch (err) {
          res = { error: message(err) };
        }
        if ("error" in res) {
          anyFailed = true;
          await store.appendEvents([{ ...tenantEvent("pull_failed", `Could not read ${source.provider}`, res.error, [{ kind: "source", label: source.provider }]), runId }]);
          continue;
        }
        summary.pulled += res.items.length;
        pulls.push({ source, items: res.items, next: res.next, before, lastCursor: null, visitedAll: true });
        const count = res.items.length;
        await store.appendEvents([
          {
            ...tenantEvent("pull", `Read ${count} item${count === 1 ? "" : "s"} from ${source.provider}`, null, [
              { kind: "source", label: source.provider },
              { kind: "rule", label: before ? `items after ${before}` : "first pass for this account" },
            ]),
            runId,
          },
        ]);
      }

      let visited = 0;
      for (const pull of pulls) {
        const { source } = pull;
        for (const item of pull.items) {
          if (visited >= budget) {
            pull.visitedAll = false;
            break;
          }
          visited += 1;
          const externalId = source.externalId(item);
          const threadKey = source.threadKey?.(item) ?? externalId;
          const cursor = source.cursor?.(item) ?? null;
          const { item: rec, inserted } = await store.recordItem({
            app,
            tenantId,
            provider: source.provider,
            externalId,
            threadKey,
            payload: item,
            cursor,
            createdAt: nowIso,
          });
          if (cursor) pull.lastCursor = cursor;
          if (!inserted) {
            summary.duplicates += 1;
            continue;
          }
          summary.recorded += 1;

          const base = { app, tenantId, runId, itemId: rec.id, threadKey, at: nowIso };
          const ev: NewEvent[] = [
            { ...base, kind: "recorded", title: `Recorded ${source.provider} item ${externalId}`, evidence: [{ kind: "source", label: `${source.provider} ${externalId}` }] },
          ];
          const thread = await store.getThread(app, tenantId, threadKey);
          let state = (thread?.state ?? m.state.initial) as string;
          const threadActions = thread?.actionCount ?? 0;
          const setState = async (e: StateEvent<C>) => {
            state = await applyState(m as AnyManifest, store, tenantId, threadKey, state, e as StateEvent, nowIso, ev, base);
          };
          const finish = async (status: "stopped" | "ignored" | "handoff" | "artifact", reason: string | null) => {
            await store.updateItem(app, tenantId, rec.id, { status, reason });
            await store.appendEvents(ev);
          };
          const handoff = async (reason: string, title: string, evidence: Evidence[] = []) => {
            ev.push({ ...base, kind: "handoff", title, detail: reason, evidence });
            await setState({ type: "handoff", reason });
            summary.handedOff += 1;
            await finish("handoff", reason);
          };

          // 5. Hard gates. A stop is final and nothing else runs for the item.
          const stopped = runGates(m.gates, item, { app, tenantId, now, phase: "pass", threadState: state, threadActions });
          if (stopped) {
            ev.push({
              ...base,
              kind: "gate_stopped",
              title: "A gate stopped this item",
              detail: stopped.reason,
              evidence: [{ kind: "gate", label: stopped.reason }, ...(stopped.evidence ?? [])],
            });
            await setState({ type: "stopped", reason: stopped.reason });
            summary.stopped += 1;
            await finish("stopped", stopped.reason);
            continue;
          }

          // 6 and 7. Classify, behind the daily model cap.
          let c: C | null = null;
          let fallbackUsed = false;
          if (m.steps.classify) {
            const r = await runStep(m.steps.classify, item, "classify");
            if (r.ok) {
              c = r.value;
              fallbackUsed = r.fallback;
              await store.updateItem(app, tenantId, rec.id, { classification: c });
              ev.push({
                ...base,
                kind: "classified",
                title: r.fallback ? "Classified by the fallback" : "Classified",
                detail: JSON.stringify(c).slice(0, 500),
                evidence: [{ kind: r.via === "rule" ? "rule" : "model", label: r.via }, ...(r.note ? [{ kind: "rule" as const, label: r.note }] : [])],
              });
            } else {
              ev.push({
                ...base,
                kind: r.capped ? "capped" : "classify_failed",
                title: r.capped ? "Daily model cap reached before classify" : "Could not classify",
                detail: r.reason,
                evidence: [{ kind: r.capped ? "cap" : "rule", label: r.reason }],
              });
            }
            await setState({ type: "classified", classification: c });
          }

          // 8. Decide. A pure function of the item, its classification, the state and the policy.
          let d: Decision<A>;
          try {
            d = m.steps.decide(item, c, state as S, policy);
          } catch (err) {
            d = { kind: "handoff", reason: `decide threw: ${message(err)}` };
          }
          ev.push({ ...base, kind: "decided", title: `Decided: ${d.kind}`, detail: "reason" in d ? d.reason : null, evidence: d.evidence ?? [] });

          if (d.kind === "stop") {
            await setState({ type: "stopped", reason: d.reason });
            summary.stopped += 1;
            await finish("stopped", d.reason);
            continue;
          }
          if (d.kind === "ignore") {
            await setState({ type: "ignored", reason: d.reason });
            summary.ignored += 1;
            await finish("ignored", d.reason);
            continue;
          }
          if (d.kind === "handoff") {
            await handoff(d.reason, "Handed to a person, with no draft", d.evidence ?? []);
            continue;
          }

          // The per-thread cap. A thread at its cap belongs to the person who inherits it.
          if (capReached(threadActions, m.caps.perThread)) {
            await handoff("thread_cap", "Thread cap reached, so a person takes it", [
              { kind: "cap", label: `${threadActions} actions already in this thread; the cap is ${m.caps.perThread}` },
            ]);
            continue;
          }

          // 9. Draft, then the draft checks.
          let artifact: A;
          if (d.kind === "schedule") {
            artifact = d.artifact;
          } else {
            if (!m.steps.draft) {
              await handoff("no_draft_step", "Staged with no draft step, so a person takes it");
              continue;
            }
            const r = await runStep(m.steps.draft, { item, c }, "draft");
            if (!r.ok) {
              await handoff(r.capped ? "inference_cap" : "no_draft", r.capped ? "Daily model cap reached before the draft" : "No usable draft", [
                { kind: r.capped ? "cap" : "rule", label: r.reason },
              ]);
              continue;
            }
            artifact = r.value;
            fallbackUsed = fallbackUsed || r.fallback;
            ev.push({
              ...base,
              kind: "drafted",
              title: r.fallback ? "Drafted by the fallback" : "Drafted",
              evidence: [{ kind: r.via === "template" ? "rule" : "model", label: r.via }, ...(r.note ? [{ kind: "rule" as const, label: r.note }] : [])],
            });
            let refused: string | null = null;
            for (const check of m.steps.checkDraft ?? []) {
              try {
                refused = check(artifact, item);
              } catch (err) {
                refused = `a draft check threw: ${message(err)}`;
              }
              if (refused) break;
            }
            if (refused) {
              await handoff("guardrail", "A draft check refused the draft", [{ kind: "rule", label: refused }]);
              continue;
            }
          }
          if (!artifact || typeof artifact.kind !== "string" || !m.actions[artifact.kind]) {
            await handoff("no_action", "No action connector for this artifact", [{ kind: "rule", label: `kind "${artifact?.kind}" has no action` }]);
            continue;
          }

          // 10. Route: held for a tap, or queued behind the undo window.
          const holdReasons: string[] = [];
          for (const rule of m.approval.alwaysHold) {
            try {
              const why = rule(item, c);
              if (why) holdReasons.push(why);
            } catch (err) {
              holdReasons.push(`a hold rule threw: ${message(err)}`);
            }
          }
          const amount = m.approval.holdOverAmount ? m.approval.holdOverAmount(item) : null;
          const threshold = settings.holdOverThreshold ?? m.approval.holdOverThreshold ?? null;
          const routed = route({ mode: settings.mode, holdReasons, fallback: fallbackUsed, amount, threshold });
          const releaseAt = routed.status === "queued" ? addSeconds(now, m.approval.undoSeconds) : null;
          const created = await store.createArtifact({
            app,
            tenantId,
            itemId: rec.id,
            threadKey,
            runId,
            kind: artifact.kind,
            payload: artifact,
            status: routed.status,
            reason: routed.reasons.length ? routed.reasons.join("; ") : null,
            releaseAt,
            fallback: fallbackUsed,
            amount,
            createdAt: nowIso,
          });
          ev.push({
            ...base,
            artifactId: created.id,
            kind: routed.status,
            title: routed.status === "held" ? "Waiting for approval" : `Queued; it can be sent after ${releaseAt}`,
            evidence:
              routed.status === "held"
                ? routed.reasons.map((label) => ({ kind: "rule" as const, label }))
                : [{ kind: "rule", label: `autopilot, behind a ${m.approval.undoSeconds}s undo window` }],
          });
          if (routed.status === "held") summary.held += 1;
          else summary.queued += 1;

          // 11 and 12. The state transition and the item's ledger rows.
          await setState({ type: routed.status });
          await finish("artifact", null);
        }
      }

      // 13. The watermark moves only after the batch is written, and not at all if a source failed.
      if (anyFailed) {
        await store.appendEvents([
          { ...tenantEvent("watermark_kept", "A source failed, so no watermark moved", null, [{ kind: "rule", label: "the next pass re-reads from the old watermark" }]), runId },
        ]);
      } else {
        for (const pull of pulls) {
          const p = pull.source.provider;
          let after = pull.before;
          if (pull.source.cursor) after = pull.lastCursor ?? pull.before;
          else if (pull.visitedAll && pull.next) after = pull.next;
          summary.watermarks[p] = { before: pull.before, after };
          if (after && after !== pull.before) {
            await store.setWatermark(app, tenantId, p, after, nowIso);
            await store.appendEvents([
              { ...tenantEvent("watermark", `Watermark for ${p} moved`, `${pull.before ?? "none"} to ${after}`, [{ kind: "source", label: p }]), runId },
            ]);
          }
        }
      }

      summary.ok = true;
      await store.finishRun(app, runId, "done", summary, nowIso);
      return summary;
    } catch (err) {
      log(`${app}: the pass for ${tenantId} failed`, err);
      summary.reason = message(err);
      try {
        await store.finishRun(app, runId, "failed", summary, nowIso);
      } catch (finishErr) {
        log(`${app}: could not mark run ${runId} failed`, finishErr);
      }
      return summary;
    }
  }

  /* ------------------------------ the dispatcher ------------------------------ */

  async function runDispatch(m: AnyManifest, now: Date = clock()): Promise<DispatchSummary> {
    const store = storeFor(m);
    const nowIso = now.toISOString();
    const summary: DispatchSummary = {
      app: m.app,
      ok: false,
      due: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      blocked: 0,
      releasedToHeld: 0,
      leftQueued: 0,
      lostClaim: 0,
      reclaimed: 0,
    };

    const stale = await store.reclaimStaleSending(m.app, new Date(now.getTime() - staleClaimMs).toISOString(), nowIso);
    summary.reclaimed = stale.length;
    for (const a of stale) {
      await store.appendEvents([
        {
          app: m.app,
          tenantId: a.tenantId,
          artifactId: a.id,
          itemId: a.itemId,
          threadKey: a.threadKey,
          kind: "failed",
          title: "The dispatcher stopped mid send, so this was marked failed",
          detail: "There is no proof it left. Nothing resends it by itself.",
          evidence: [{ kind: "rule", label: "a claimed row is never resent" }],
          at: nowIso,
        },
      ]);
    }

    let demoId: string | null;
    try {
      demoId = await m.tenants.idForEmail(m.billing.demoEmail);
    } catch (err) {
      log(`${m.app}: the demo lookup failed; the dispatcher sends nothing this tick`, err);
      return { ...summary, reason: "demo-lookup-failed" };
    }

    // 1. Only queued rows whose release_at has passed.
    const due = await store.listDueArtifacts(m.app, nowIso, batch);
    summary.due = due.length;
    const entitledCache = new Map<string, boolean>();
    const sentToday = new Map<string, number>();
    const dayStart = utcDayStart(now);

    for (const row of due) {
      // 2. Claim. Exactly one of this, a second tick and an undo finds the row queued.
      const a = await store.transitionArtifact(m.app, row.id, ["queued"], "sending", {}, nowIso);
      if (!a) {
        summary.lostClaim += 1;
        continue;
      }
      summary.claimed += 1;
      const base = { app: m.app, tenantId: a.tenantId, itemId: a.itemId, artifactId: a.id, threadKey: a.threadKey, at: nowIso };
      const ev: NewEvent[] = [];
      const putBack = async (to: "queued" | "held", reason: string, kind: string, title: string, evidence: Evidence[]) => {
        await store.transitionArtifact(m.app, a.id, ["sending"], to, to === "held" ? { reason, releaseAt: null } : {}, nowIso);
        await store.appendEvents([{ ...base, kind, title, detail: reason, evidence }]);
      };

      if (demoId !== null && a.tenantId === demoId) {
        await putBack("queued", "the demo account never sends", "skipped", "Demo account; nothing was sent", [{ kind: "rule", label: "the demo account never sends" }]);
        summary.leftQueued += 1;
        continue;
      }

      // 3. Entitlement, again. An unentitled row waits in the queue.
      if (!entitledCache.has(a.tenantId)) entitledCache.set(a.tenantId, await entitled(m, a.tenantId));
      if (!entitledCache.get(a.tenantId)) {
        await putBack("queued", "no active plan", "unentitled", "No active plan, so this stays queued", [{ kind: "rule", label: "nothing is sent for an account without an active plan" }]);
        summary.leftQueued += 1;
        continue;
      }

      // 4. Gates on current data.
      const itemRec = await store.getItem(m.app, a.tenantId, a.itemId);
      if (!itemRec) {
        await store.transitionArtifact(m.app, a.id, ["sending"], "blocked", { reason: "the item this answers is missing" }, nowIso);
        await store.appendEvents([{ ...base, kind: "blocked", title: "Blocked: the item this answers is missing", evidence: [{ kind: "rule", label: "nothing is sent without its source item" }] }]);
        summary.blocked += 1;
        continue;
      }
      const cur = await currentItem(m, itemRec.provider, itemRec.externalId, itemRec.payload, a.tenantId);
      if ("error" in cur) {
        await putBack("queued", cur.error, "refresh_failed", "Could not re-read the item, so this stays queued", [{ kind: "source", label: itemRec.provider }]);
        summary.leftQueued += 1;
        continue;
      }
      const thread = await store.getThread(m.app, a.tenantId, a.threadKey);
      const threadState = thread?.state ?? m.state.initial;
      const threadActions = thread?.actionCount ?? 0;
      const gateStop =
        "gone" in cur
          ? { stop: true as const, reason: "the source item no longer exists" }
          : runGates(m.gates, cur.item, { app: m.app, tenantId: a.tenantId, now, phase: "dispatch", threadState, threadActions });
      if (gateStop) {
        await store.transitionArtifact(m.app, a.id, ["sending"], "blocked", { reason: gateStop.reason }, nowIso);
        ev.push({ ...base, kind: "blocked", title: "Blocked by a gate at send time", detail: gateStop.reason, evidence: [{ kind: "gate", label: gateStop.reason }] });
        await applyState(m, store, a.tenantId, a.threadKey, threadState, { type: "blocked", reason: gateStop.reason }, nowIso, ev, base);
        await store.appendEvents(ev);
        summary.blocked += 1;
        continue;
      }

      // 5. Caps, re-counted now. Over a cap, the row goes back to a person.
      if (capReached(threadActions, m.caps.perThread)) {
        await putBack("held", "the thread cap is reached", "capped", "Thread cap reached, so this waits for a person", [{ kind: "cap", label: `thread cap: ${m.caps.perThread}` }]);
        summary.releasedToHeld += 1;
        continue;
      }
      if (!sentToday.has(a.tenantId)) sentToday.set(a.tenantId, await store.countSentSince(m.app, a.tenantId, dayStart));
      const sent = sentToday.get(a.tenantId) as number;
      if (capReached(sent, m.caps.actionsPerDay)) {
        await putBack("held", "the daily action cap is reached", "capped", "Daily action cap reached, so this waits for a person", [
          { kind: "cap", label: `${sent} of ${m.caps.actionsPerDay} actions today` },
        ]);
        summary.releasedToHeld += 1;
        continue;
      }

      const action = m.actions[a.kind];
      if (!action) {
        await store.transitionArtifact(m.app, a.id, ["sending"], "failed", { reason: `no action connector for "${a.kind}"` }, nowIso);
        await store.appendEvents([{ ...base, kind: "failed", title: "No action connector for this artifact", evidence: [{ kind: "rule", label: a.kind }] }]);
        summary.failed += 1;
        continue;
      }

      // 6. The receipt is written first. If it cannot be written, nothing is sent.
      try {
        await store.appendEvents([
          {
            ...base,
            kind: "receipt",
            title: `Receipt: ${a.kind} through ${action.provider}`,
            detail: `artifact ${a.id}`,
            evidence: [
              { kind: "receipt", label: `artifact ${a.id}` },
              { kind: "rule", label: a.approvedAt ? `approved at ${a.approvedAt}` : "queued by autopilot" },
              { kind: "rule", label: `released at ${a.releaseAt}` },
              { kind: "cap", label: `${sent + 1} of ${m.caps.actionsPerDay} actions today` },
              { kind: "source", label: action.provider },
              ...(a.edited ? [{ kind: "rule" as const, label: "edited by a person before approval" }] : []),
            ],
          },
        ]);
      } catch (err) {
        log(`${m.app}: the receipt for ${a.id} could not be written; the send is abandoned`, err);
        await store.transitionArtifact(m.app, a.id, ["sending"], "queued", {}, nowIso);
        summary.leftQueued += 1;
        continue;
      }

      // 7. The action. A refusal is final.
      let result: ActionResult;
      try {
        result = await action.perform(a.tenantId, a.payload, { itemId: a.itemId, artifactId: a.id });
      } catch (err) {
        result = { ok: false, reason: `the action threw: ${message(err)}` };
      }

      // 8. The outcome and the connector's own id.
      try {
        if (result.ok) {
          await store.transitionArtifact(m.app, a.id, ["sending"], "sent", { sentAt: nowIso, externalId: result.externalId ?? null }, nowIso);
          await store.bumpThreadActions(m.app, a.tenantId, a.threadKey, nowIso);
          sentToday.set(a.tenantId, sent + 1);
          ev.push({
            ...base,
            kind: "sent",
            title: `Sent through ${action.provider}`,
            detail: result.externalId ?? null,
            evidence: [{ kind: "source", label: result.externalId ? `${action.provider} id ${result.externalId}` : action.provider }],
          });
          await applyState(m, store, a.tenantId, a.threadKey, threadState, { type: "sent" }, nowIso, ev, base);
          summary.sent += 1;
        } else {
          await store.transitionArtifact(m.app, a.id, ["sending"], "failed", { reason: result.reason }, nowIso);
          ev.push({ ...base, kind: "failed", title: `${action.provider} refused the action`, detail: result.reason, evidence: [{ kind: "rule", label: "a refused write is never retried" }] });
          await applyState(m, store, a.tenantId, a.threadKey, threadState, { type: "failed", reason: result.reason }, nowIso, ev, base);
          summary.failed += 1;
        }
        await store.appendEvents(ev);
      } catch (err) {
        // The receipt already exists. A failure here is logged, and the row is never resent.
        log(`${m.app}: recording the outcome of ${a.id} failed`, err);
      }
    }

    summary.ok = true;
    return summary;
  }

  /* --------------------------- approval and undo --------------------------- */

  async function guardHuman(m: AnyManifest, tenantId: string) {
    if (!(await entitled(m, tenantId))) throw new RunnerError("unentitled", 402, "this account has no active plan");
    let demoId: string | null;
    try {
      demoId = await m.tenants.idForEmail(m.billing.demoEmail);
    } catch (err) {
      throw new RunnerError("demo_lookup_failed", 503, `the demo lookup failed: ${message(err)}`);
    }
    if (demoId !== null && demoId === tenantId) throw new RunnerError("demo", 403, "the demo account never approves or sends");
  }

  async function approve<A extends { kind: string }>(
    m: AgentManifest<any, A, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    tenantId: string,
    artifactId: string,
    edits?: Partial<Omit<A, "kind">>,
    now: Date = clock(),
  ): Promise<{ releaseAt: string }> {
    const store = storeFor(m);
    const nowIso = now.toISOString();
    const a = await store.getArtifact(m.app, tenantId, artifactId);
    if (!a) throw new RunnerError("not_found", 404, "artifact not found");
    if (a.status !== "held") throw new RunnerError("conflict", 409, `the artifact is ${a.status}, not waiting for approval`);
    await guardHuman(m, tenantId);

    const itemRec = await store.getItem(m.app, tenantId, a.itemId);
    const thread = await store.getThread(m.app, tenantId, a.threadKey);
    const threadState = thread?.state ?? m.state.initial;
    const base = { app: m.app, tenantId, itemId: a.itemId, artifactId: a.id, threadKey: a.threadKey, at: nowIso };
    const cur = itemRec ? await currentItem(m, itemRec.provider, itemRec.externalId, itemRec.payload, tenantId) : ({ gone: true } as const);
    if ("error" in cur) throw new RunnerError("conflict", 409, `could not re-read the item: ${cur.error}`);
    const gateStop =
      "gone" in cur
        ? { stop: true as const, reason: "the source item no longer exists" }
        : runGates(m.gates, cur.item, {
            app: m.app,
            tenantId,
            now,
            phase: "approve" as GatePhase,
            threadState,
            threadActions: thread?.actionCount ?? 0,
          });
    if (gateStop) {
      await store.transitionArtifact(m.app, a.id, ["held"], "blocked", { reason: gateStop.reason }, nowIso, tenantId);
      await store.appendEvents([{ ...base, kind: "blocked", title: "Approval refused by a gate", detail: gateStop.reason, evidence: [{ kind: "gate", label: gateStop.reason }] }]);
      throw new RunnerError("gate_stopped", 409, gateStop.reason);
    }

    const payload = edits ? ({ ...(a.payload as A), ...edits, kind: a.kind } as A) : (a.payload as A);
    const edited = edits !== undefined && JSON.stringify(payload) !== JSON.stringify(a.payload);
    const releaseAt = addSeconds(now, m.approval.undoSeconds);
    const moved = await store.transitionArtifact(
      m.app,
      a.id,
      ["held"],
      "queued",
      { payload, releaseAt, approvedAt: nowIso, approvedClean: !edited, edited: edited || a.edited, reason: null },
      nowIso,
      tenantId,
    );
    if (!moved) throw new RunnerError("conflict", 409, "the artifact was no longer waiting for approval");
    if (!edited) await store.adjustCleanApprovals(m.app, tenantId, 1, m.approval.defaultMode);

    const ev: NewEvent[] = [
      {
        ...base,
        kind: edited ? "edited" : "approved",
        title: edited ? "Edited and approved" : "Approved",
        detail: `It can be sent after ${releaseAt}`,
        evidence: [
          { kind: "rule", label: `held ${m.approval.undoSeconds}s before it can be sent` },
          ...(edited ? [{ kind: "rule" as const, label: "an edited approval does not count toward autopilot" }] : []),
        ],
      },
    ];
    await applyState(m, store, tenantId, a.threadKey, threadState, { type: "approved" }, nowIso, ev, base);
    await store.appendEvents(ev);
    return { releaseAt };
  }

  async function undo(m: AnyManifest, tenantId: string, artifactId: string, now: Date = clock()): Promise<boolean> {
    const store = storeFor(m);
    const nowIso = now.toISOString();
    const before = await store.getArtifact(m.app, tenantId, artifactId);
    if (!before) return false;
    // The conditional flip. If the dispatcher claimed the row first, this finds nothing to move.
    const moved = await store.transitionArtifact(m.app, artifactId, ["queued"], "cancelled", { releaseAt: null, approvedClean: false }, nowIso, tenantId);
    if (!moved) return false;
    if (before.approvedClean) await store.adjustCleanApprovals(m.app, tenantId, -1, m.approval.defaultMode);
    const base = { app: m.app, tenantId, itemId: moved.itemId, artifactId, threadKey: moved.threadKey, at: nowIso };
    const thread = await store.getThread(m.app, tenantId, moved.threadKey);
    const ev: NewEvent[] = [
      {
        ...base,
        kind: "undone",
        title: "Undone inside the window; nothing was sent",
        evidence: [
          { kind: "rule", label: `undo window: ${m.approval.undoSeconds}s` },
          ...(before.approvedClean ? [{ kind: "rule" as const, label: "one clean approval was taken back" }] : []),
        ],
      },
    ];
    await applyState(m, store, tenantId, moved.threadKey, thread?.state ?? m.state.initial, { type: "undone" }, nowIso, ev, base);
    await store.appendEvents(ev);
    return true;
  }

  async function reject(m: AnyManifest, tenantId: string, artifactId: string, now: Date = clock()): Promise<boolean> {
    const store = storeFor(m);
    const nowIso = now.toISOString();
    const moved = await store.transitionArtifact(m.app, artifactId, ["held"], "rejected", {}, nowIso, tenantId);
    if (!moved) return false;
    const base = { app: m.app, tenantId, itemId: moved.itemId, artifactId, threadKey: moved.threadKey, at: nowIso };
    const thread = await store.getThread(m.app, tenantId, moved.threadKey);
    const ev: NewEvent[] = [{ ...base, kind: "rejected", title: "Rejected; nothing will be sent", evidence: [{ kind: "rule", label: "a rejected artifact is never dispatched" }] }];
    await applyState(m, store, tenantId, moved.threadKey, thread?.state ?? m.state.initial, { type: "rejected" }, nowIso, ev, base);
    await store.appendEvents(ev);
    return true;
  }

  async function setMode(m: AnyManifest, tenantId: string, mode: Mode, now: Date = clock()): Promise<TenantSettings> {
    const store = storeFor(m);
    const current = await settingsFor(m, store, tenantId);
    if (mode === "autopilot" && !autopilotUnlocked(current.mode, current.cleanApprovals, m.approval.cleanApprovalsToUnlock)) {
      throw new RunnerError(
        "locked",
        409,
        `autopilot unlocks after ${m.approval.cleanApprovalsToUnlock} approvals without an edit; this account has ${current.cleanApprovals}`,
      );
    }
    const next = { ...current, mode };
    await store.saveTenantSettings(m.app, tenantId, next);
    await store.appendEvents([
      {
        app: m.app,
        tenantId,
        kind: "mode",
        title: `Mode set to ${mode}`,
        detail: `was ${current.mode}`,
        evidence: [{ kind: "rule", label: `${current.cleanApprovals} clean approvals` }],
        at: now.toISOString(),
      },
    ]);
    return next;
  }

  async function overview(m: AnyManifest, tenantId: string, now: Date = clock()): Promise<Overview> {
    const store = storeFor(m);
    const dayStart = utcDayStart(now);
    const [settings, sentToday, inferenceToday, artifacts, events] = await Promise.all([
      settingsFor(m, store, tenantId),
      store.countSentSince(m.app, tenantId, dayStart),
      store.countInferenceSince(m.app, tenantId, dayStart),
      store.listArtifacts(m.app, tenantId, { limit: 100 }),
      store.listEvents(m.app, tenantId, { limit: 60 }),
    ]);
    return {
      settings,
      unlocksAutopilotAt: m.approval.cleanApprovalsToUnlock,
      sentToday,
      inferenceToday,
      caps: m.caps,
      undoSeconds: m.approval.undoSeconds,
      artifacts,
      events,
    };
  }

  async function tick(manifests: AnyManifest[], job: "pass" | "dispatch", now: Date = clock()): Promise<TickResult[]> {
    const out: TickResult[] = [];
    for (const m of manifests) {
      let due: boolean;
      try {
        due = cronMatches(m.schedule[job], now);
      } catch (err) {
        out.push({ app: m.app, job, due: false, error: message(err) });
        continue;
      }
      if (!due) {
        out.push({ app: m.app, job, due: false });
        continue;
      }
      try {
        if (job === "dispatch") {
          out.push({ app: m.app, job, due: true, dispatch: await runDispatch(m, now) });
        } else {
          const passes: PassSummary[] = [];
          for (const tenantId of await m.tenants.list()) passes.push(await runPass(m, tenantId, now));
          out.push({ app: m.app, job, due: true, passes });
        }
      } catch (err) {
        log(`${m.app}: the ${job} tick failed`, err);
        out.push({ app: m.app, job, due: true, error: message(err) });
      }
    }
    return out;
  }

  return {
    runPass,
    runDispatch,
    approve,
    undo,
    reject,
    setMode,
    settings: (m, tenantId) => settingsFor(m, storeFor(m), tenantId),
    overview,
    tick,
  };
}
