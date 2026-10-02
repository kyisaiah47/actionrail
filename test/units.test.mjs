// Pure pieces: cron auth, cron matching, routing, rules, JSON parsing and manifest checks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cronAuthorized,
  cronMatches,
  cronRoute,
  defineManifest,
  firstMatch,
  isCronRequest,
  parseModelJson,
  route,
  ruleTable,
  secretMatches,
  utcDayStart,
  withinTolerance,
} from "../dist/index.js";

describe("cron auth", () => {
  it("refuses every caller when the secret is unset, empty or blank", () => {
    for (const secret of [undefined, null, "", "   "]) {
      assert.equal(cronAuthorized("Bearer ", secret), false);
      assert.equal(cronAuthorized("Bearer undefined", secret), false);
      assert.equal(cronAuthorized(`Bearer ${secret}`, secret), false);
    }
  });

  it("accepts only the exact bearer", () => {
    assert.equal(cronAuthorized("Bearer s3cret-value", "s3cret-value"), true);
    assert.equal(cronAuthorized("Bearer s3cret-valu", "s3cret-value"), false);
    assert.equal(cronAuthorized("bearer s3cret-value", "s3cret-value"), false);
    assert.equal(cronAuthorized("s3cret-value", "s3cret-value"), false);
    assert.equal(cronAuthorized(null, "s3cret-value"), false);
    assert.equal(secretMatches("", "x"), false);
  });

  it("does not accept a scheduler header as proof", () => {
    const req = new Request("https://app.example/api/cron/pass", { headers: { "x-vercel-cron": "1" } });
    assert.equal(isCronRequest(req, "s3cret-value"), false);
  });

  it("answers 401 without running the tick", async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return 1;
    };
    const unset = await cronRoute(new Request("https://app.example/x", { headers: { authorization: "Bearer " } }), run, undefined);
    assert.equal(unset.status, 401);
    const wrong = await cronRoute(new Request("https://app.example/x", { headers: { authorization: "Bearer nope" } }), run, "s3cret-value");
    assert.equal(wrong.status, 401);
    assert.equal(ran, false);
    const ok = await cronRoute(new Request("https://app.example/x", { headers: { authorization: "Bearer s3cret-value" } }), run, "s3cret-value");
    assert.equal(ok.status, 200);
    assert.equal(ran, true);
  });
});

describe("cron matching", () => {
  const d = (iso) => new Date(iso);
  it("matches minutes, hours, steps, ranges and lists in UTC", () => {
    assert.equal(cronMatches("10 5 * * *", d("2026-10-02T05:10:42Z")), true);
    assert.equal(cronMatches("10 5 * * *", d("2026-10-02T05:11:00Z")), false);
    assert.equal(cronMatches("*/5 * * * *", d("2026-10-02T13:35:00Z")), true);
    assert.equal(cronMatches("*/5 * * * *", d("2026-10-02T13:36:00Z")), false);
    assert.equal(cronMatches("0 9-17 * * 1-5", d("2026-10-02T12:00:00Z")), true, "Friday at noon");
    assert.equal(cronMatches("0 9-17 * * 1-5", d("2026-10-04T12:00:00Z")), false, "Sunday");
    assert.equal(cronMatches("0 0 * * 7", d("2026-10-04T00:00:00Z")), true, "7 is Sunday");
    assert.equal(cronMatches("0,30 * * * *", d("2026-10-02T13:30:00Z")), true);
    assert.equal(cronMatches("0 0 1 * 1", d("2026-10-05T00:00:00Z")), true, "either day field matches");
  });
  it("throws on a malformed expression", () => {
    assert.throws(() => cronMatches("* * *", new Date()));
    assert.throws(() => cronMatches("61 * * * *", new Date()));
    assert.throws(() => cronMatches("*/0 * * * *", new Date()));
  });
});

describe("routing", () => {
  const base = { holdReasons: [], fallback: false, amount: null, threshold: null };
  it("holds everything in manual and copilot", () => {
    assert.equal(route({ ...base, mode: "manual" }).status, "held");
    assert.equal(route({ ...base, mode: "copilot" }).status, "held");
  });
  it("queues in autopilot unless something holds it", () => {
    assert.equal(route({ ...base, mode: "autopilot" }).status, "queued");
    assert.equal(route({ ...base, mode: "autopilot", fallback: true }).status, "held");
    assert.equal(route({ ...base, mode: "autopilot", holdReasons: ["x"] }).status, "held");
    assert.equal(route({ ...base, mode: "autopilot", amount: 501, threshold: 500 }).status, "held");
    assert.equal(route({ ...base, mode: "autopilot", amount: 500, threshold: 500 }).status, "queued");
  });
});

describe("rules", () => {
  it("labels by the first matching rule", () => {
    const step = firstMatch([{ label: "a", when: (x) => x > 5, because: "big" }], "b");
    assert.deepEqual(step.run(9), { label: "a", because: "big", confidence: 1 });
    assert.equal(step.run(1).label, "b");
  });
  it("scores with a reason for every point", () => {
    const step = ruleTable([
      { id: "x", when: () => true, points: 3, reason: "always" },
      { id: "y", when: () => false, points: 9, reason: "never" },
    ]);
    assert.deepEqual(step.run({}), { score: 3, reasons: [{ id: "x", points: 3, reason: "always" }] });
    assert.throws(() => ruleTable([{ id: "x", when: () => true, points: 1, reason: "" }, { id: "x", when: () => true, points: 1, reason: "" }]));
  });
  it("matches on tolerance", () => {
    assert.equal(withinTolerance(100, 100.4, { abs: 0.5 }), true);
    assert.equal(withinTolerance(100, 101, { abs: 0.5 }), false);
    assert.equal(withinTolerance(1000, 1009, { pct: 0.01 }), true);
    assert.equal(withinTolerance(5, 5, {}), true);
    assert.equal(withinTolerance(5, 6, {}), false);
  });
});

describe("model JSON", () => {
  it("reads fenced and wrapped JSON and refuses the rest", () => {
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseModelJson('Here you go: {"a":2} hope that helps'), { a: 2 });
    assert.equal(parseModelJson("no json here"), null);
    assert.equal(parseModelJson("[1,2]"), null);
  });
});

describe("days", () => {
  it("starts the day at midnight UTC", () => {
    assert.equal(utcDayStart(new Date("2026-10-02T23:59:59.999Z")), "2026-10-02T00:00:00.000Z");
  });
});

describe("manifest checks", () => {
  const ok = () => ({
    app: "x",
    billing: { gate: "subscription", isEntitled: async () => true, demoEmail: "demo@example.com" },
    tenants: { list: async () => [], idForEmail: async () => null },
    schedule: { pass: "0 5 * * *", dispatch: "*/5 * * * *" },
    sources: [{ provider: "p", listSince: async () => ({ items: [], next: null }), externalId: () => "" }],
    actions: { a: { provider: "p", perform: async () => ({ ok: true }) } },
    gates: [],
    steps: { decide: () => ({ kind: "ignore", reason: "" }) },
    approval: { defaultMode: "copilot", alwaysHold: [], cleanApprovalsToUnlock: 1, undoSeconds: 30 },
    caps: { inferencePerDay: 1, actionsPerDay: 1 },
    state: { initial: "a", transition: () => null },
    ledger: { events: "e", artifacts: "a" },
  });
  it("accepts a complete manifest", () => {
    assert.doesNotThrow(() => defineManifest(ok()));
  });
  it("refuses a manifest with no undo window, a zero cap or a bad cron", () => {
    assert.throws(() => defineManifest({ ...ok(), approval: { ...ok().approval, undoSeconds: 0 } }), /undoSeconds/);
    assert.throws(() => defineManifest({ ...ok(), caps: { inferencePerDay: 0, actionsPerDay: 1 } }), /inferencePerDay/);
    assert.throws(() => defineManifest({ ...ok(), schedule: { pass: "daily", dispatch: "*/5 * * * *" } }), /schedule.pass/);
    assert.throws(() => defineManifest({ ...ok(), actions: {} }), /action/);
  });
});
