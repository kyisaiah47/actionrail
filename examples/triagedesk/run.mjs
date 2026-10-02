// Runs the TriageDesk manifest end to end against a mailbox that lives in memory.
//
//   npm run example                       a scripted stub model, no network
//   GEMINI_API_KEY=... node examples/triagedesk/run.mjs --gemini
//                                         the same loop on Gemini's free tier
//
// It delivers four synthetic messages, runs a pass, approves the one draft, shows that the
// dispatcher sends nothing inside the undo window, then dispatches after it and prints the ledger.
// It writes what the run produced to examples/triagedesk/out/: the pass summary, the queue, the
// mail the dispatcher sent and the ledger with its evidence.

import { mkdirSync, writeFileSync } from "node:fs";
import { FakeMailbox, MemoryStore, createRunner, geminiProvider, stubProvider } from "actionrail";
import { triageDeskManifest } from "./manifest.mjs";

const TENANT = "tenant-acme";
const mailbox = new FakeMailbox("support@acme.example", "Acme support");

/** A scripted model: it labels by keyword and drafts from the message, like a careful model would. */
export function scriptedModel() {
  return stubProvider((req) => {
    if (req.system?.startsWith("You triage")) {
      const body = req.prompt;
      if (/cancel/i.test(body)) return { category: "cancellation", priority: "normal", confidence: 0.95, summary: "Wants to cancel the account.", quotes: ["Please cancel our account"] };
      if (/out of office/i.test(body)) return { category: "automated", priority: "low", confidence: 0.99, summary: "An out-of-office reply.", quotes: [] };
      if (/charged twice|two charges/i.test(body)) return { category: "billing", priority: "normal", confidence: 0.9, summary: "Asks which of two charges is correct.", quotes: ["two charges"] };
      return { category: "question", priority: "normal", confidence: 0.92, summary: "Asks how to export a report as CSV.", quotes: ["export last month's report as a CSV"] };
    }
    if (/two charges/i.test(req.prompt)) {
      return { subject: "Re: Second charge", body: "Thanks for flagging this. We are checking both charges against your account now and will come back to you with what we find. Acme support" };
    }
    return {
      subject: "Re: Exporting a report as CSV",
      body: "Open Reports, pick last month, then choose Export and CSV. The file downloads straight away. Acme support",
    };
  });
}

export function buildDemo(provider) {
  const store = new MemoryStore();
  const manifest = triageDeskManifest({
    openMailbox: async () => mailbox,
    isEntitled: async (t) => t === TENANT,
    listTenants: async () => [TENANT],
    idForEmail: async () => "tenant-demo",
    voice: { teamName: "Acme", signoff: "Acme support" },
  });
  const runner = createRunner({ store, provider });
  return { store, manifest, runner };
}

async function main() {
  const useGemini = process.argv.includes("--gemini");
  if (useGemini && !process.env.GEMINI_API_KEY) {
    console.error("Set GEMINI_API_KEY to run on Gemini's free tier.");
    process.exitCode = 2;
    return;
  }
  const provider = useGemini ? geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: "gemini-2.5-flash" }) : scriptedModel();
  const { store, manifest, runner } = buildDemo(provider);

  const t0 = new Date("2026-10-02T05:10:00.000Z");
  mailbox.deliver({ fromEmail: "dana@customer.example", fromName: "Dana Reyes", subject: "Exporting a report as CSV", bodyText: "Hi, how do I export last month's report as a CSV file? I can only find the PDF button.", receivedAt: "2026-10-02T01:00:00.000Z" });
  mailbox.deliver({ fromEmail: "sam@customer.example", fromName: "Sam Ito", subject: "Please cancel", bodyText: "Please cancel our account at the end of this month.", receivedAt: "2026-10-02T02:00:00.000Z" });
  mailbox.deliver({ fromEmail: "no-reply@vendor.example", subject: "Out of office", bodyText: "I am out of office until Monday.", receivedAt: "2026-10-02T03:00:00.000Z" });
  mailbox.deliver({ fromEmail: "support@acme.example", subject: "Note to self", bodyText: "Remember to update the help article.", receivedAt: "2026-10-02T04:00:00.000Z" });

  const pass = await runner.runPass(manifest, TENANT, t0);
  console.log("Pass:", { recorded: pass.recorded, held: pass.held, handedOff: pass.handedOff, ignored: pass.ignored, stopped: pass.stopped, modelCalls: pass.inferenceCalls });

  const held = await store.listArtifacts("triagedesk", TENANT, { status: ["held"] });
  for (const a of held) console.log(`\nWaiting for approval: ${a.payload.subject}\n${a.payload.body}`);

  const before = await runner.runDispatch(manifest, new Date(t0.getTime() + 60 * 60 * 1000));
  console.log("\nDispatch before any approval sent:", before.sent);

  const approvedAt = new Date(t0.getTime() + 2 * 60 * 60 * 1000);
  for (const a of held) {
    const { releaseAt } = await runner.approve(manifest, TENANT, a.id, undefined, approvedAt);
    console.log(`Approved "${a.payload.subject}". It can be sent after ${releaseAt}.`);
  }
  const inside = await runner.runDispatch(manifest, new Date(approvedAt.getTime() + 60 * 1000));
  console.log("Dispatch 60s after approval sent:", inside.sent);
  const after = await runner.runDispatch(manifest, new Date(approvedAt.getTime() + 121 * 1000));
  console.log("Dispatch 121s after approval sent:", after.sent);
  console.log("Mailbox sent:", mailbox.sent.map((s) => s.subject));

  console.log("\nLedger:");
  const events = await store.listEvents("triagedesk", TENANT);
  for (const e of events) console.log(`  ${e.at.slice(11, 19)} ${e.kind.padEnd(14)} ${e.title}`);

  // Random ids are left out, so the files are the same on every run.
  const out = new URL("./out/", import.meta.url);
  mkdirSync(out, { recursive: true });
  const write = (name, value) => writeFileSync(new URL(name, out), `${JSON.stringify(value, null, 2)}\n`);
  write("pass.json", { recorded: pass.recorded, held: pass.held, handedOff: pass.handedOff, ignored: pass.ignored, stopped: pass.stopped, modelCalls: pass.inferenceCalls });
  write("queue.json", (await store.listArtifacts("triagedesk", TENANT)).map((a) => ({
    kind: a.kind, status: a.status, reason: a.reason, subject: a.payload.subject, body: a.payload.body,
    approvedAt: a.approvedAt, releaseAt: a.releaseAt, sentAt: a.sentAt,
  })));
  write("sent.json", mailbox.sent.map((m) => ({ subject: m.subject, body: m.body ?? m.bodyText ?? null })));
  write("ledger.json", events.map((e) => ({ at: e.at, kind: e.kind, title: e.title, detail: e.detail, evidence: e.evidence })));
  console.log("\nWrote examples/triagedesk/out/: pass.json, queue.json, sent.json, ledger.json");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
