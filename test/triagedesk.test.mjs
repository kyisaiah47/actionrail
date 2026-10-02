// The worked example: the TriageDesk manifest against the fake mailbox, on every store.
// Classify then draft, approval holds sends, undo cancels inside the window, the receipt is
// written first, and the rest of the loop's promises.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMailbox, createRunner, stubProvider } from "../dist/index.js";
import { triageDeskManifest } from "../examples/triagedesk/manifest.mjs";
import { STORES, at, plus, storeFor } from "./helpers.mjs";

const TENANT = "tenant-acme";
const T0 = at("2026-10-02T05:10:00.000Z");

function classifier(overrides = {}) {
  return (p) => {
    if (overrides.classify) {
      const r = overrides.classify(p);
      if (r) return r;
    }
    if (/cancel/i.test(p)) return { category: "cancellation", priority: "normal", confidence: 0.95, summary: "Wants to cancel.", quotes: ["Please cancel our account"] };
    if (/lawyer/i.test(p)) return { category: "legal", priority: "urgent", confidence: 0.9, summary: "Mentions a lawyer.", quotes: ["our lawyer"] };
    if (/unacceptable/i.test(p)) return { category: "complaint", priority: "urgent", confidence: 0.9, summary: "An angry complaint.", quotes: ["unacceptable"] };
    if (/out of office/i.test(p)) return { category: "automated", priority: "low", confidence: 0.99, summary: "Out of office.", quotes: [] };
    if (/backlinks/i.test(p)) return { category: "spam", priority: "low", confidence: 0.99, summary: "Link outreach.", quotes: [] };
    return { category: "question", priority: "normal", confidence: 0.92, summary: "Asks how to export as CSV.", quotes: ["export last month's report as a CSV", "this quote is not in the message"] };
  };
}

function model(overrides = {}) {
  const classify = classifier(overrides);
  return stubProvider((req) => {
    if (req.system?.startsWith("You triage")) return classify(req.prompt);
    if (overrides.draft) return overrides.draft(req);
    return { subject: "Re: Exporting a report as CSV", body: "Open Reports, pick last month, then choose Export and CSV. The file downloads straight away." };
  });
}

async function setup(kind, opts = {}) {
  const mailbox = new FakeMailbox("support@acme.example");
  const entitled = opts.entitled ?? new Set([TENANT]);
  const manifest = triageDeskManifest({
    openMailbox: async () => mailbox,
    isEntitled: async (t) => entitled.has(t),
    listTenants: async () => [TENANT],
    idForEmail: opts.idForEmail ?? (async () => "tenant-demo"),
    voice: { savedAnswers: opts.savedAnswers ?? [] },
  });
  if (opts.caps) Object.assign(manifest.caps, opts.caps);
  const store = opts.wrapStore ? opts.wrapStore(await storeFor(kind, manifest)) : await storeFor(kind, manifest);
  const provider = opts.provider ?? model(opts.model);
  const runner = createRunner({ store, provider, log: () => {} });
  return { mailbox, manifest, store, provider, runner };
}

function question(mailbox, n = 1, minutes = 0) {
  return mailbox.deliver({
    fromEmail: `customer${n}@customer.example`,
    fromName: "Dana Reyes",
    subject: "Exporting a report as CSV",
    bodyText: "Hi, how do I export last month's report as a CSV file? I can only find the PDF button.",
    receivedAt: new Date(Date.UTC(2026, 9, 2, 1, minutes, n)).toISOString(),
  });
}

for (const kind of STORES) {
  describe(`TriageDesk example on the ${kind.name} store`, () => {
    it("classifies, then drafts, and holds the draft for approval", async () => {
      const { mailbox, manifest, store, provider, runner } = await setup(kind);
      question(mailbox);
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.ok, true);
      assert.equal(pass.held, 1);
      assert.equal(provider.calls.length, 2);
      assert.match(provider.calls[0].system, /^You triage/);
      assert.match(provider.calls[1].system, /^You draft the reply/);

      const [item] = await Promise.all([store.listArtifacts("triagedesk", TENANT)]);
      assert.equal(item.length, 1);
      const draft = item[0];
      assert.equal(draft.status, "held");
      assert.equal(draft.releaseAt, null);
      assert.equal(draft.payload.kind, "reply");
      assert.match(draft.payload.body, /Open Reports/);

      const stored = await store.getItem("triagedesk", TENANT, draft.itemId);
      assert.equal(stored.classification.category, "question");
      assert.deepEqual(stored.classification.quotes, ["export last month's report as a CSV"], "an invented quote is dropped");

      const kinds = (await store.listEvents("triagedesk", TENANT)).map((e) => e.kind);
      assert.ok(kinds.indexOf("classified") < kinds.indexOf("drafted"), "classify runs before draft");
      assert.ok(kinds.indexOf("drafted") < kinds.indexOf("held"));
    });

    it("sends nothing while a draft waits for approval", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      for (const hours of [1, 6, 48]) {
        const d = await runner.runDispatch(manifest, plus(T0, hours * 3600));
        assert.equal(d.sent, 0);
        assert.equal(d.due, 0);
      }
      assert.equal(mailbox.sent.length, 0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      assert.equal(a.status, "held");
    });

    it("holds an approved reply for the undo window, then sends it", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      const approvedAt = plus(T0, 3600);
      const { releaseAt } = await runner.approve(manifest, TENANT, a.id, undefined, approvedAt);
      assert.equal(releaseAt, plus(approvedAt, 120).toISOString());

      const inside = await runner.runDispatch(manifest, plus(approvedAt, 119));
      assert.equal(inside.sent, 0);
      assert.equal(mailbox.sent.length, 0);

      const after = await runner.runDispatch(manifest, plus(approvedAt, 120));
      assert.equal(after.sent, 1);
      assert.equal(mailbox.sent.length, 1);
      assert.equal(mailbox.sent[0].replyTo, a.payload.replyTo);
      assert.match(mailbox.sent[0].body, /Open Reports/);

      const sent = await store.getArtifact("triagedesk", TENANT, a.id);
      assert.equal(sent.status, "sent");
      assert.equal(sent.externalId, "sent-1");
      assert.equal((await store.getThread("triagedesk", TENANT, a.threadKey)).state, "answered");
    });

    it("cancels the send when undo lands inside the window", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      const approvedAt = plus(T0, 3600);
      await runner.approve(manifest, TENANT, a.id, undefined, approvedAt);
      assert.equal((await runner.settings(manifest, TENANT)).cleanApprovals, 1);

      assert.equal(await runner.undo(manifest, TENANT, a.id, plus(approvedAt, 30)), true);
      assert.equal((await runner.settings(manifest, TENANT)).cleanApprovals, 0, "an undo takes the clean approval back");

      const d = await runner.runDispatch(manifest, plus(approvedAt, 600));
      assert.equal(d.sent, 0);
      assert.equal(mailbox.sent.length, 0);
      assert.equal((await store.getArtifact("triagedesk", TENANT, a.id)).status, "cancelled");
      assert.equal(await runner.undo(manifest, TENANT, a.id, plus(approvedAt, 601)), false, "a second undo finds nothing to move");
    });

    it("loses the undo once the dispatcher has claimed the row", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      await runner.approve(manifest, TENANT, a.id, undefined, T0);
      await runner.runDispatch(manifest, plus(T0, 121));
      assert.equal(mailbox.sent.length, 1);
      assert.equal(await runner.undo(manifest, TENANT, a.id, plus(T0, 122)), false);
    });

    it("writes the receipt before the mailbox is called", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      await runner.approve(manifest, TENANT, a.id, undefined, T0);
      let receiptSeenAtSend = false;
      mailbox.onSend = async () => {
        const rows = await store.listEvents("triagedesk", TENANT, { artifactId: a.id });
        receiptSeenAtSend = rows.some((e) => e.kind === "receipt");
      };
      await runner.runDispatch(manifest, plus(T0, 121));
      assert.equal(receiptSeenAtSend, true);
      const kinds = (await store.listEvents("triagedesk", TENANT, { artifactId: a.id })).map((e) => e.kind);
      assert.ok(kinds.indexOf("receipt") < kinds.indexOf("sent"));
    });

    it("abandons the send when the receipt cannot be written", async () => {
      let failReceipts = true;
      const { mailbox, manifest, store, runner } = await setup(kind, {
        wrapStore: (inner) =>
          new Proxy(inner, {
            get(target, prop, recv) {
              if (prop === "scope") return () => recv;
              if (prop === "appendEvents") {
                return async (rows) => {
                  if (failReceipts && rows.some((r) => r.kind === "receipt")) throw new Error("ledger is down");
                  return target.appendEvents(rows);
                };
              }
              const v = Reflect.get(target, prop, target);
              return typeof v === "function" ? v.bind(target) : v;
            },
          }),
      });
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      await runner.approve(manifest, TENANT, a.id, undefined, T0);

      const failed = await runner.runDispatch(manifest, plus(T0, 121));
      assert.equal(failed.sent, 0);
      assert.equal(failed.leftQueued, 1);
      assert.equal(mailbox.sent.length, 0);
      assert.equal((await store.getArtifact("triagedesk", TENANT, a.id)).status, "queued");

      failReceipts = false;
      const ok = await runner.runDispatch(manifest, plus(T0, 300));
      assert.equal(ok.sent, 1);
      assert.equal(mailbox.sent.length, 1);
    });

    it("hands complaints, legal mail and cancellations to a person with no draft, and ignores noise", async () => {
      const { mailbox, manifest, store, provider, runner } = await setup(kind);
      const msgs = [
        ["Please cancel our account at the end of the month.", "Cancel"],
        ["Our lawyer will contact you about the contract.", "Contract"],
        ["This is unacceptable. Third outage this week.", "Outage"],
        ["I am out of office until Monday.", "Out of office"],
        ["We can offer you backlinks from high authority sites.", "Partnership"],
      ];
      msgs.forEach(([body, subject], i) =>
        mailbox.deliver({ fromEmail: `p${i}@customer.example`, subject, bodyText: body, receivedAt: new Date(Date.UTC(2026, 9, 2, 1, i)).toISOString() }),
      );
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.handedOff, 3);
      assert.equal(pass.ignored, 2);
      assert.equal(pass.held, 0);
      assert.equal(provider.calls.length, 5, "one classify per message and no draft call");
      assert.equal((await store.listArtifacts("triagedesk", TENANT)).length, 0);
    });

    it("refuses a draft that promises a refund nobody offered", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind, {
        model: { draft: () => ({ subject: "Re: CSV", body: "Sorry about that. We have refunded your last invoice and you can export from Reports." }) },
      });
      question(mailbox);
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.handedOff, 1);
      assert.equal(pass.held, 0);
      const events = await store.listEvents("triagedesk", TENANT);
      const handoff = events.find((e) => e.kind === "handoff");
      assert.equal(handoff.detail, "guardrail");
      assert.match(handoff.evidence[0].label, /refund/);
    });

    it("allows a commitment that a saved answer already makes", async () => {
      const { mailbox, manifest, runner } = await setup(kind, {
        savedAnswers: ["Duplicate charges are refunded within 5 days."],
        model: { draft: () => ({ subject: "Re: CSV", body: "If a charge is duplicated it is refunded. Export from Reports, then CSV." }) },
      });
      question(mailbox);
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.held, 1);
    });

    it("refuses a draft that leaves a placeholder for a person to fill in", async () => {
      const { mailbox, manifest, runner } = await setup(kind, {
        model: { draft: () => ({ subject: "Re: CSV", body: "Hi [Name], open Reports and choose Export, then CSV." }) },
      });
      question(mailbox);
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.handedOff, 1, "the parse fails twice, there is no fallback, so a person takes it");
    });

    it("stops mail the team sent itself before any model call", async () => {
      const { mailbox, manifest, provider, runner } = await setup(kind);
      mailbox.deliver({ fromEmail: "support@acme.example", subject: "Note", bodyText: "Update the help article.", receivedAt: "2026-10-02T01:00:00.000Z" });
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(pass.stopped, 1);
      assert.equal(provider.calls.length, 0);
    });

    it("moves the watermark after the batch is written, and keeps it when the mailbox fails", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox, 1, 0);
      question(mailbox, 2, 5);
      const first = await runner.runPass(manifest, TENANT, T0);
      const newest = new Date(Date.UTC(2026, 9, 2, 1, 5, 2)).toISOString();
      assert.equal(first.watermarks.mailbox.after, newest);
      assert.equal(await store.getWatermark("triagedesk", TENANT, "mailbox"), newest);

      question(mailbox, 3, 10);
      mailbox.failNextList = "graph answered 503";
      const second = await runner.runPass(manifest, TENANT, plus(T0, 86400));
      assert.equal(second.recorded, 0);
      assert.equal(await store.getWatermark("triagedesk", TENANT, "mailbox"), newest);

      const third = await runner.runPass(manifest, TENANT, plus(T0, 2 * 86400));
      assert.equal(third.recorded, 1, "the third message is read on the next pass, not skipped");
    });

    it("never calls the model once the daily cap is reached", async () => {
      const { mailbox, manifest, provider, runner } = await setup(kind, { caps: { inferencePerDay: 3 } });
      question(mailbox, 1);
      question(mailbox, 2, 1);
      question(mailbox, 3, 2);
      const pass = await runner.runPass(manifest, TENANT, T0);
      assert.equal(provider.calls.length, 3);
      assert.equal(pass.inferenceCalls, 3);
      assert.equal(pass.held, 1);
      assert.equal(pass.handedOff, 2);
      const again = await runner.runPass(manifest, TENANT, plus(T0, 3600));
      assert.equal(again.inferenceCalls, 0);
      assert.equal(provider.calls.length, 3);
    });

    it("sends at most the daily action cap and puts the rest back for a person", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind, { caps: { actionsPerDay: 2 } });
      for (let n = 1; n <= 3; n++) question(mailbox, n, n);
      await runner.runPass(manifest, TENANT, T0);
      for (const a of await store.listArtifacts("triagedesk", TENANT)) await runner.approve(manifest, TENANT, a.id, undefined, T0);
      const d = await runner.runDispatch(manifest, plus(T0, 121));
      assert.equal(d.sent, 2);
      assert.equal(d.releasedToHeld, 1);
      assert.equal(mailbox.sent.length, 2);
      const held = await store.listArtifacts("triagedesk", TENANT, { status: ["held"] });
      assert.equal(held.length, 1);
      assert.equal(held[0].reason, "the daily action cap is reached");
    });

    it("runs no pass for an account without a plan, and none for the demo account", async () => {
      const unpaid = await setup(kind, { entitled: new Set() });
      question(unpaid.mailbox);
      const p1 = await unpaid.runner.runPass(unpaid.manifest, TENANT, T0);
      assert.equal(p1.reason, "unentitled");
      assert.equal(p1.unentitled, 1);
      assert.equal(unpaid.provider.calls.length, 0);

      const demo = await setup(kind, { entitled: new Set([TENANT]), idForEmail: async () => TENANT });
      question(demo.mailbox);
      const p2 = await demo.runner.runPass(demo.manifest, TENANT, T0);
      assert.equal(p2.reason, "demo");
      assert.equal(demo.provider.calls.length, 0);

      const broken = await setup(kind, {
        idForEmail: async () => {
          throw new Error("auth lookup timed out");
        },
      });
      question(broken.mailbox);
      const p3 = await broken.runner.runPass(broken.manifest, TENANT, T0);
      assert.equal(p3.reason, "demo-lookup-failed");
      assert.equal(broken.provider.calls.length, 0);
    });

    it("leaves an approved reply queued when the account loses its plan", async () => {
      const entitled = new Set([TENANT]);
      const { mailbox, manifest, store, runner } = await setup(kind, { entitled });
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      await runner.approve(manifest, TENANT, a.id, undefined, T0);
      entitled.delete(TENANT);
      const d = await runner.runDispatch(manifest, plus(T0, 121));
      assert.equal(d.sent, 0);
      assert.equal(d.leftQueued, 1);
      assert.equal((await store.getArtifact("triagedesk", TENANT, a.id)).status, "queued");
    });

    it("hands a thread to a person once it has three replies", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      let now = T0;
      for (let n = 1; n <= 4; n++) {
        mailbox.deliver({
          fromEmail: "dana@customer.example",
          threadKey: "conv-1",
          subject: "Exporting a report as CSV",
          bodyText: "Hi, how do I export last month's report as a CSV file?",
          receivedAt: new Date(Date.UTC(2026, 9, 2, n, 0)).toISOString(),
        });
        const pass = await runner.runPass(manifest, TENANT, now);
        if (n <= 3) {
          assert.equal(pass.held, 1, `reply ${n} is drafted`);
          const [a] = await store.listArtifacts("triagedesk", TENANT, { status: ["held"] });
          await runner.approve(manifest, TENANT, a.id, undefined, now);
          await runner.runDispatch(manifest, plus(now, 121));
        } else {
          assert.equal(pass.handedOff, 1, "the fourth message goes to a person");
        }
        now = plus(now, 3600);
      }
      assert.equal(mailbox.sent.length, 3);
    });

    it("refuses approval for the demo account", async () => {
      const { mailbox, manifest, store, runner } = await setup(kind);
      question(mailbox);
      await runner.runPass(manifest, TENANT, T0);
      const [a] = await store.listArtifacts("triagedesk", TENANT);
      const demoManifest = { ...manifest, tenants: { ...manifest.tenants, idForEmail: async () => TENANT } };
      await assert.rejects(runner.approve(demoManifest, TENANT, a.id, undefined, T0), { code: "demo" });
    });
  });
}
