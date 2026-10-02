// The TriageDesk example on Gemini's free tier. It runs only when GEMINI_API_KEY is set, and it
// skips otherwise, so CI never needs a key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMailbox, MemoryStore, createRunner, geminiProvider } from "../dist/index.js";
import { TRIAGE_CATEGORIES, triageDeskManifest } from "../examples/triagedesk/manifest.mjs";

const key = process.env.GEMINI_API_KEY;

describe("TriageDesk on Gemini's free tier", { skip: key ? false : "GEMINI_API_KEY is not set" }, () => {
  it("classifies and drafts a real question, and holds the draft", async () => {
    const mailbox = new FakeMailbox("support@acme.example");
    mailbox.deliver({
      fromEmail: "dana@customer.example",
      fromName: "Dana Reyes",
      subject: "Exporting a report as CSV",
      bodyText: "Hi, how do I export last month's report as a CSV file? I can only find the PDF button.",
      receivedAt: "2026-10-02T01:00:00.000Z",
    });
    const store = new MemoryStore();
    const manifest = triageDeskManifest({
      openMailbox: async () => mailbox,
      isEntitled: async () => true,
      listTenants: async () => ["t"],
      idForEmail: async () => null,
      voice: { savedAnswers: ["Reports can be exported from Reports, then Export, then CSV."] },
    });
    const runner = createRunner({ store, provider: geminiProvider({ apiKey: key, model: "gemini-2.5-flash" }), log: () => {} });
    const pass = await runner.runPass(manifest, "t", new Date("2026-10-02T05:10:00.000Z"));
    assert.equal(pass.ok, true);
    assert.ok(pass.inferenceCalls >= 1);
    const [item] = [...store.items.values()];
    assert.ok(item.classification === null || TRIAGE_CATEGORIES.includes(item.classification.category));
    const artifacts = await store.listArtifacts("triagedesk", "t");
    if (artifacts.length) {
      assert.equal(artifacts[0].status, "held");
      assert.ok(artifacts[0].payload.body.length >= 20);
    }
    assert.equal(mailbox.sent.length, 0, "nothing is sent without approval");
  });
});
