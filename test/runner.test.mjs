// The runner's rules on synthetic manifests, on every store: autonomy and its unlock, hold rules,
// the amount threshold, fallbacks, gates at approve and dispatch, refused writes, stale claims,
// racing claims, one pass per tenant, the cron tick, and a rules-only app with no model at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allow, createRunner, defineManifest, firstMatch, hardStop, ruleTable, stop, stubProvider } from "../dist/index.js";
import { STORES, arraySource, at, plus, recordingAction, storeFor } from "./helpers.mjs";

const T0 = at("2026-10-02T06:00:00.000Z");
const TENANT = "t1";

function build({ source = arraySource(), action = recordingAction(), overrides = {} } = {}) {
  const m = defineManifest({
    app: "synthetic",
    billing: { gate: "subscription", isEntitled: async () => true, demoEmail: "demo@example.com" },
    tenants: { list: async () => [TENANT, "t2"], idForEmail: async () => "demo" },
    schedule: { pass: "0 6 * * *", dispatch: "*/5 * * * *" },
    sources: [source],
    actions: { note: action },
    gates: [(i) => (i.blocked ? stop("item is blocked") : allow())],
    steps: {
      classify: {
        capability: "classify",
        build: (i) => ({ prompt: i.text }),
        parse: (j) => (typeof j.label === "string" ? { label: j.label } : null),
        fallback: () => ({ label: "unknown" }),
      },
      decide: () => ({ kind: "stage" }),
      draft: { kind: "template", render: ({ item }) => ({ kind: "note", text: `about ${item.id}` }) },
    },
    approval: {
      defaultMode: "copilot",
      alwaysHold: [(i) => (i.sensitive ? "sensitive items always wait" : null)],
      holdOverAmount: (i) => i.amount ?? 0,
      holdOverThreshold: 500,
      cleanApprovalsToUnlock: 2,
      undoSeconds: 60,
    },
    caps: { inferencePerDay: 50, actionsPerDay: 50, perThread: 5, perPass: 20 },
    state: { initial: "new", transition: (s, e) => (e.type === "sent" ? "done" : s) },
    ledger: { events: "synthetic_events", artifacts: "synthetic_artifacts", runs: "synthetic_runs" },
    ...overrides,
  });
  return { m, source, action };
}

const labelModel = () => stubProvider(() => ({ label: "ok" }));

async function approveAllHeld(runner, m, store, now) {
  for (const a of await store.listArtifacts(m.app, TENANT, { status: ["held"] })) await runner.approve(m, TENANT, a.id, undefined, now);
}

for (const kind of STORES) {
  describe(`runner on the ${kind.name} store`, () => {
    it("unlocks autopilot only after enough clean approvals, then queues behind the undo window", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      await assert.rejects(runner.setMode(m, TENANT, "autopilot", T0), { code: "locked" });

      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" }, { id: "b", at: "2026-10-02T01:01:00.000Z", text: "y" });
      await runner.runPass(m, TENANT, T0);
      const held = await store.listArtifacts(m.app, TENANT, { status: ["held"] });
      assert.equal(held.length, 2);
      await runner.approve(m, TENANT, held[0].id, { text: "edited" }, T0);
      assert.equal((await runner.settings(m, TENANT)).cleanApprovals, 0, "an edited approval is not clean");
      await assert.rejects(runner.setMode(m, TENANT, "autopilot", T0), { code: "locked" });
      await runner.approve(m, TENANT, held[1].id, undefined, T0);
      assert.equal((await runner.settings(m, TENANT)).cleanApprovals, 1);

      source.items.push({ id: "c", at: "2026-10-02T01:02:00.000Z", text: "z" });
      await runner.runPass(m, TENANT, plus(T0, 600));
      await approveAllHeld(runner, m, store, plus(T0, 600));
      const s = await runner.setMode(m, TENANT, "autopilot", plus(T0, 601));
      assert.equal(s.mode, "autopilot");

      source.items.push(
        { id: "d", at: "2026-10-02T01:03:00.000Z", text: "plain" },
        { id: "e", at: "2026-10-02T01:04:00.000Z", text: "sensitive", sensitive: true },
        { id: "f", at: "2026-10-02T01:05:00.000Z", text: "big", amount: 900 },
      );
      const t = plus(T0, 1200);
      const pass = await runner.runPass(m, TENANT, t);
      assert.equal(pass.queued, 1);
      assert.equal(pass.held, 2);
      const queued = (await store.listArtifacts(m.app, TENANT, { status: ["queued"] })).find((a) => a.payload.text === "about d");
      assert.equal(queued.releaseAt, plus(t, 60).toISOString());
      const heldNow = await store.listArtifacts(m.app, TENANT, { status: ["held"] });
      const reasons = heldNow.map((a) => a.reason).join(" | ");
      assert.match(reasons, /sensitive items always wait/);
      assert.match(reasons, /amount 900 is over the autopilot threshold of 500/);
    });

    it("never queues a fallback result, even in autopilot", async () => {
      const { m, source } = build({ overrides: { approval: { defaultMode: "autopilot", alwaysHold: [], cleanApprovalsToUnlock: 0, undoSeconds: 60 } } });
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: stubProvider(() => "this is not json"), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      const pass = await runner.runPass(m, TENANT, T0);
      assert.equal(pass.inferenceCalls, 2, "an unparseable answer is retried once");
      assert.equal(pass.held, 1);
      assert.equal(pass.queued, 0);
      const [a] = await store.listArtifacts(m.app, TENANT);
      assert.equal(a.fallback, true);
      assert.match(a.reason, /fallback/);
    });

    it("runs the fallback with no provider at all, and holds it", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      const pass = await runner.runPass(m, TENANT, T0);
      assert.equal(pass.ok, true);
      assert.equal(pass.inferenceCalls, 0);
      assert.equal(pass.held, 1);
    });

    it("re-runs the gates at approval and blocks a stopped item", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      await runner.runPass(m, TENANT, T0);
      const [a] = await store.listArtifacts(m.app, TENANT);
      source.patched.set("a", { blocked: true });
      await assert.rejects(runner.approve(m, TENANT, a.id, undefined, T0), { code: "gate_stopped" });
      assert.equal((await store.getArtifact(m.app, TENANT, a.id)).status, "blocked");
    });

    it("re-runs the gates at dispatch on current data", async () => {
      const { m, source, action } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" }, { id: "b", at: "2026-10-02T01:01:00.000Z", text: "y" });
      await runner.runPass(m, TENANT, T0);
      await approveAllHeld(runner, m, store, T0);
      source.patched.set("a", { blocked: true });
      source.removed.add("b");
      const d = await runner.runDispatch(m, plus(T0, 61));
      assert.equal(d.blocked, 2);
      assert.equal(d.sent, 0);
      assert.equal(action.performed.length, 0);
    });

    it("never retries a refused write", async () => {
      const { m, source, action } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      await runner.runPass(m, TENANT, T0);
      await approveAllHeld(runner, m, store, T0);
      action.refuse = "the account is read-only";
      const d1 = await runner.runDispatch(m, plus(T0, 61));
      assert.equal(d1.failed, 1);
      action.refuse = null;
      const d2 = await runner.runDispatch(m, plus(T0, 600));
      assert.equal(d2.due, 0);
      assert.equal(action.performed.length, 0);
      const [a] = await store.listArtifacts(m.app, TENANT);
      assert.equal(a.status, "failed");
      assert.equal(a.reason, "the account is read-only");
    });

    it("fails a row left in sending and never resends it", async () => {
      const { m, source, action } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      await runner.runPass(m, TENANT, T0);
      const [a] = await store.listArtifacts(m.app, TENANT);
      await runner.approve(m, TENANT, a.id, undefined, T0);
      // A tick claims the row and dies before sending.
      await store.transitionArtifact(m.app, a.id, ["queued"], "sending", {}, plus(T0, 61).toISOString());
      const d = await runner.runDispatch(m, plus(T0, 61 + 31 * 60));
      assert.equal(d.reclaimed, 1);
      assert.equal(d.sent, 0);
      assert.equal(action.performed.length, 0);
      assert.equal((await store.getArtifact(m.app, TENANT, a.id)).status, "failed");
    });

    it("lets exactly one of two racing dispatchers send a row", async () => {
      const { m, source, action } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      for (let i = 0; i < 4; i++) source.items.push({ id: `i${i}`, at: `2026-10-02T01:0${i}:00.000Z`, text: "x" });
      await runner.runPass(m, TENANT, T0);
      await approveAllHeld(runner, m, store, T0);
      const [d1, d2] = await Promise.all([runner.runDispatch(m, plus(T0, 61)), runner.runDispatch(m, plus(T0, 61))]);
      assert.equal(d1.sent + d2.sent, 4);
      assert.equal(action.performed.length, 4);
      assert.equal(new Set(action.performed.map((p) => p.ctx.artifactId)).size, 4);
    });

    it("runs one pass per tenant at a time", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      const run = await store.startRun(m.app, TENANT, T0.toISOString(), plus(T0, -900).toISOString());
      assert.ok(run);
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      const blocked = await runner.runPass(m, TENANT, plus(T0, 60));
      assert.equal(blocked.reason, "already-running");
      const other = await runner.runPass(m, "t2", plus(T0, 60));
      assert.equal(other.ok, true, "another tenant is not blocked");
      const later = await runner.runPass(m, TENANT, plus(T0, 16 * 60));
      assert.equal(later.ok, true, "a pass older than the lease is treated as dead");
    });

    it("keeps every watermark when any source fails", async () => {
      const a = arraySource("first");
      const b = arraySource("second");
      const { m } = build({ overrides: { sources: [a, b] } });
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      a.items.push({ id: "a1", at: "2026-10-02T01:00:00.000Z", text: "x" });
      b.items.push({ id: "b1", at: "2026-10-02T01:00:00.000Z", text: "x" });
      b.failNext = "rate limited";
      const pass = await runner.runPass(m, TENANT, T0);
      assert.equal(pass.recorded, 1);
      assert.equal(await store.getWatermark(m.app, TENANT, "first"), null);
      assert.equal(await store.getWatermark(m.app, TENANT, "second"), null);
      const next = await runner.runPass(m, TENANT, plus(T0, 60));
      assert.equal(next.recorded, 1, "b1 is read now");
      assert.equal(next.duplicates, 1, "a1 is re-read and recognised");
      assert.equal(await store.getWatermark(m.app, TENANT, "first"), "2026-10-02T01:00:00.000Z");
    });

    it("resumes from the watermark when a pass hits its item budget", async () => {
      const { m, source } = build({ overrides: { caps: { inferencePerDay: 50, actionsPerDay: 50, perPass: 2 } } });
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      for (let i = 0; i < 5; i++) source.items.push({ id: `i${i}`, at: `2026-10-02T01:0${i}:00.000Z`, text: "x" });
      const p1 = await runner.runPass(m, TENANT, T0);
      assert.equal(p1.recorded, 2);
      assert.equal(p1.watermarks.list.after, "2026-10-02T01:01:00.000Z");
      const p2 = await runner.runPass(m, TENANT, plus(T0, 60));
      assert.equal(p2.recorded, 2);
      const p3 = await runner.runPass(m, TENANT, plus(T0, 120));
      assert.equal(p3.recorded, 1);
    });

    it("runs the due manifests on a tick and skips the rest", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      const notDue = await runner.tick([m], "pass", at("2026-10-02T06:01:00.000Z"));
      assert.equal(notDue[0].due, false);
      const due = await runner.tick([m], "pass", at("2026-10-02T06:00:30.000Z"));
      assert.equal(due[0].due, true);
      assert.equal(due[0].passes.length, 2, "one pass per tenant");
      const dispatch = await runner.tick([m], "dispatch", at("2026-10-02T06:05:00.000Z"));
      assert.equal(dispatch[0].due, true);
      assert.equal(dispatch[0].dispatch.ok, true);
    });

    it("rejects only a held artifact", async () => {
      const { m, source } = build();
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, provider: labelModel(), log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      await runner.runPass(m, TENANT, T0);
      const [a] = await store.listArtifacts(m.app, TENANT);
      assert.equal(await runner.reject(m, TENANT, a.id, T0), true);
      assert.equal(await runner.reject(m, TENANT, a.id, T0), false);
      await assert.rejects(runner.approve(m, TENANT, a.id, undefined, T0), { code: "conflict" });
      await assert.rejects(runner.approve(m, "someone-else", a.id, undefined, T0), { code: "not_found" });
    });

    it("runs a rules-only app with no provider: a hard stop, a scoring table and a scheduled action", async () => {
      const source = arraySource("billing");
      const action = recordingAction("payments");
      const score = ruleTable([
        { id: "card-updated", when: (i) => i.cardUpdated, points: 40, reason: "the card was updated since the failure" },
        { id: "small", when: (i) => i.amount < 5000, points: 20, reason: "under 50.00" },
      ]);
      const m = defineManifest({
        app: "retries",
        billing: { gate: "subscription", isEntitled: async () => true, demoEmail: "demo@example.com" },
        tenants: { list: async () => [TENANT], idForEmail: async () => null },
        schedule: { pass: "10 3 * * *", dispatch: "*/5 * * * *" },
        sources: [source],
        actions: { retry: action },
        gates: [hardStop(["stolen_card", "do_not_honor_permanent"], (i) => i.code, "hard decline")],
        steps: {
          classify: firstMatch([{ label: "retryable", when: (i) => i.code === "insufficient_funds", because: "a soft decline" }], "other"),
          decide: (item, c) => {
            if (c?.label !== "retryable") return { kind: "handoff", reason: "not a soft decline" };
            const s = score.run(item);
            return s.score >= 40 ? { kind: "schedule", artifact: { kind: "retry", invoice: item.id }, evidence: s.reasons.map((r) => ({ kind: "rule", label: r.reason })) } : { kind: "stop", reason: "score too low" };
          },
        },
        approval: { defaultMode: "copilot", alwaysHold: [], cleanApprovalsToUnlock: 10, undoSeconds: 30 },
        caps: { inferencePerDay: 1, actionsPerDay: 10 },
        state: { initial: "open", transition: (s) => s },
        ledger: { events: "retries_events", artifacts: "retries_artifacts" },
      });
      const store = await storeFor(kind, m);
      const runner = createRunner({ store, log: () => {} });
      source.items.push(
        { id: "in_1", at: "2026-10-02T01:00:00.000Z", code: "stolen_card", amount: 100 },
        { id: "in_2", at: "2026-10-02T01:01:00.000Z", code: "insufficient_funds", amount: 1000, cardUpdated: true },
        { id: "in_3", at: "2026-10-02T01:02:00.000Z", code: "insufficient_funds", amount: 9000 },
        { id: "in_4", at: "2026-10-02T01:03:00.000Z", code: "expired_card", amount: 100 },
      );
      const pass = await runner.runPass(m, TENANT, T0);
      assert.equal(pass.inferenceCalls, 0);
      assert.equal(pass.stopped, 2, "the hard decline and the low score");
      assert.equal(pass.handedOff, 1);
      assert.equal(pass.held, 1);
      const [a] = await store.listArtifacts(m.app, TENANT);
      await runner.approve(m, TENANT, a.id, undefined, T0);
      await runner.runDispatch(m, plus(T0, 31));
      assert.deepEqual(action.performed.map((p) => p.artifact.invoice), ["in_2"]);
    });
  });
}

describe("model retries", () => {
  it("retries once after a rate limit or a provider-side error, and not after a refusal", async () => {
    const { ProviderError, MemoryStore } = await import("../dist/index.js");
    for (const [status, expectCalls, expectHeld] of [
      [503, 2, 1],
      [429, 2, 1],
      [400, 1, 1],
    ]) {
      const { m, source } = build({ overrides: { steps: { ...build().m.steps, classify: { capability: "classify", build: (i) => ({ prompt: i.text }), parse: (j) => (j.label ? { label: j.label } : null) } } } });
      let n = 0;
      const provider = stubProvider(() => (n++ === 0 ? new ProviderError("stub", status, "busy") : { label: "ok" }));
      const runner = createRunner({ store: new MemoryStore(), provider, retryDelayMs: 1, log: () => {} });
      source.items.push({ id: "a", at: "2026-10-02T01:00:00.000Z", text: "x" });
      const pass = await runner.runPass(m, TENANT, T0);
      assert.equal(pass.inferenceCalls, expectCalls, `status ${status}`);
      assert.equal(pass.held, expectHeld);
    }
  });
});
