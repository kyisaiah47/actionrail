// THE TRIAGEDESK MANIFEST. TriageDesk reads a small team's shared inbox overnight, labels each
// message, drafts a reply for the ones it may answer, and leaves a queue for the morning. This is
// its loop expressed as an ActionRail manifest, rewritten from TriageDesk's own classify, draft
// and guardrail code. The data below is synthetic.
//
// What it keeps from TriageDesk:
//   - eleven categories. Complaint, legal and cancellation go to a person with no draft. Automated
//     mail and spam are recorded and never answered;
//   - quotes in a classification must appear in the message, or they are dropped;
//   - a draft with a bracketed placeholder is refused;
//   - a draft that commits to a refund, a credit, a cancellation, a guarantee, a date or a discount
//     that the source material does not contain is refused, and the thread goes to a person;
//   - three replies per thread, 120 sends and 200 model calls per account per day, 60 messages
//     per pass, and a 120 second undo window;
//   - every draft waits for approval (copilot).

import {
  allow,
  decideByLabel,
  defineManifest,
  mailboxReplyAction,
  mailboxSource,
  stop,
} from "actionrail";

/** @typedef {import("actionrail").InboundMessage} InboundMessage */
/** @typedef {import("actionrail").ReplyArtifact} ReplyArtifact */
/**
 * @typedef {{ category: string, priority: "urgent" | "normal" | "low", confidence: number, summary: string, quotes: string[] }} Classification
 */

export const TRIAGE_CATEGORIES = [
  "question",
  "bug",
  "billing",
  "sales",
  "onboarding",
  "feature_request",
  "complaint",
  "legal",
  "cancellation",
  "automated",
  "spam",
];
export const HANDOFF_CATEGORIES = ["complaint", "legal", "cancellation"];
export const NOISE_CATEGORIES = ["automated", "spam"];
const PRIORITIES = ["urgent", "normal", "low"];

const CATEGORY_GUIDE = [
  "question: asks how to do something, or what something means. The default for a real person asking for help.",
  "bug: reports something broken, erroring, missing, slow or behaving wrong.",
  "billing: invoices, charges, cards, refunds asked about, plan changes, receipts, tax documents.",
  "sales: before purchase, such as pricing, plans, trials, procurement, security questionnaires, demos.",
  "onboarding: a new customer getting set up, such as access, imports, first configuration.",
  "feature_request: asks for something the product does not do yet.",
  "complaint: angry, abusive, threatening to leave, or escalating past the first ask.",
  "legal: mentions lawyers, liability, GDPR or DSAR, contract terms, a subpoena, or a regulator.",
  "cancellation: asks to cancel, downgrade, close the account or stop being billed.",
  "automated: a bounce, an out-of-office, a delivery receipt, a no-reply notification, a newsletter.",
  "spam: unsolicited pitches, link outreach, recruiting blasts, phishing.",
].join("\n");

const PRIORITY_GUIDE = [
  "urgent: production is down, money is moving wrongly, a deadline is today, or the sender is escalating.",
  "normal: a real request with no stated deadline.",
  "low: informational, a thank-you, or something that can wait a week without cost.",
].join("\n");

/** Folds what a model re-types without changing meaning: curly quotes and whitespace. */
function norm(s) {
  return String(s)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The classify prompt for one message. */
export function buildClassificationPrompt(m) {
  return {
    system:
      "You triage messages arriving on a small team's shared inbox. Read the customer's message and pick the single best category:\n" +
      CATEGORY_GUIDE +
      "\n\nThen pick a priority:\n" +
      PRIORITY_GUIDE +
      "\n\nWrite a one-sentence summary of what the sender is asking for. Then give up to three quotes: short spans copied exactly, character for character, from the message, which are the reason for the category. Never paraphrase a quote and never invent one.\n\n" +
      'Return strict JSON only: { "category": string, "priority": string, "confidence": number from 0 to 1, "summary": string, "quotes": string[] }',
    prompt: [`Subject: ${m.subject ?? "(none)"}`, `From: ${m.fromEmail ?? "(unknown)"}`, "", (m.bodyText ?? "").slice(0, 4000), "", "Return the classification JSON."].join("\n"),
    maxTokens: 400,
  };
}

/**
 * Validates the model's classification. Null on anything outside the category list, which sends
 * the message to a person. Quotes the message does not contain are dropped.
 * @returns {Classification | null}
 */
export function parseClassification(json, m) {
  const category = json.category;
  if (typeof category !== "string" || !TRIAGE_CATEGORIES.includes(category)) return null;
  const priority = PRIORITIES.includes(json.priority) ? json.priority : "normal";
  let confidence = typeof json.confidence === "number" && Number.isFinite(json.confidence) ? json.confidence : 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  const summary = typeof json.summary === "string" ? json.summary.trim().slice(0, 240) : "";
  if (!summary) return null;
  const haystack = norm(m.bodyText ?? "");
  const quotes = (Array.isArray(json.quotes) ? json.quotes : [])
    .filter((q) => typeof q === "string" && q.trim().length > 3)
    .map((q) => q.trim().slice(0, 240))
    .filter((q) => haystack.includes(norm(q)))
    .slice(0, 3);
  return { category, priority, confidence, summary, quotes };
}

/** Everything a draft may draw on: the message and the team's saved answers. */
export function sourceMaterialFor(m, savedAnswers) {
  return [m.subject ?? "", m.bodyText ?? "", ...savedAnswers].join("\n\n");
}

export function replySubject(subject) {
  const s = (subject ?? "").trim();
  if (!s) return "Re: your message";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The draft prompt. */
export function buildReplyDraftPrompt({ item, c }, voice) {
  const savedAnswers = voice.savedAnswers ?? [];
  const system = [
    "You draft the reply a small team will send from their own shared support inbox.",
    "",
    "Rules, all of them hard:",
    "- Answer the question that was asked. Do not open with pleasantries.",
    "- Only state things present in the SOURCE MATERIAL below. If the answer is not in it, say plainly that you are checking and will come back. Never guess.",
    "- Never commit to anything the source material does not already contain: no refund, no credit, no discount, no date, no guarantee, no cancellation. A reply that does is thrown away and the thread goes to a person.",
    "- No placeholders. Never write [Name], [date], or anything in brackets a person would have to fill in.",
    "- Plain text. Three to six sentences unless the answer is a list of steps.",
    voice.teamName ? `- You are writing on behalf of ${voice.teamName}.` : "",
    voice.signoff ? `- End with exactly this sign-off: ${voice.signoff}` : "- End with a plain sign-off. Never invent a person's name.",
    "",
    'Return strict JSON only: { "subject": string, "body": string }',
  ]
    .filter(Boolean)
    .join("\n");
  const prompt = [
    `The message has been triaged as: ${c?.category ?? "unknown"} (${c?.priority ?? "normal"} priority).`,
    `What they are asking for: ${c?.summary ?? "unknown"}`,
    "",
    "SOURCE MATERIAL. Everything you are allowed to draw on.",
    "",
    "Saved answers this team has approved before:",
    savedAnswers.length ? savedAnswers.map((a) => `- ${a}`).join("\n") : "(none)",
    "",
    "The message to answer:",
    `Subject: ${item.subject ?? "(none)"}`,
    (item.bodyText ?? "").slice(0, 4000),
    "",
    "Return the reply JSON.",
  ].join("\n");
  return { system, prompt, maxTokens: 900 };
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]/;

/** Validates the model's draft. Null on anything empty or carrying a placeholder. */
export function parseDraft(json, item) {
  const subject = typeof json.subject === "string" ? json.subject.trim() : "";
  const body = typeof json.body === "string" ? json.body.trim() : "";
  if (!subject || body.length < 20) return null;
  if (PLACEHOLDER.test(body) || PLACEHOLDER.test(subject)) return null;
  return { kind: "reply", replyTo: item.id, subject: replySubject(item.subject), body };
}

/** The commitments a support reply must never invent. */
export const COMMITMENT_PATTERNS = [
  { id: "refund", re: /\b(refund(ed|ing)?|money back|reimburse[ds]?)\b/i },
  { id: "credit", re: /\b(credit(ed|ing)?|comp(ed)?\b|waive[ds]?|waiving)\b/i },
  { id: "cancel", re: /\b(cancel(led|ling)? your (plan|subscription|account))\b/i },
  { id: "guarantee", re: /\b(guarantee[ds]?|we promise|i promise)\b/i },
  { id: "date", re: /\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|end of (day|week|month))|within \d+ (hours?|days?|weeks?))\b/i },
  { id: "discount", re: /\b(discount(ed)?|\d{1,3}% off|free (month|year))\b/i },
];

/** Every commitment the draft makes that its source material does not. */
export function unsupportedCommitments(text, material) {
  return COMMITMENT_PATTERNS.filter((p) => p.re.test(text) && !p.re.test(material)).map((p) => p.id);
}

/**
 * Builds the TriageDesk manifest.
 *
 * @param {{
 *   openMailbox: (tenantId: string) => Promise<import("actionrail").MailRail | null>,
 *   isEntitled: (tenantId: string) => Promise<boolean>,
 *   listTenants: () => Promise<string[]>,
 *   idForEmail: (email: string) => Promise<string | null>,
 *   voice?: { teamName?: string, signoff?: string, savedAnswers?: string[] },
 * }} deps
 */
export function triageDeskManifest(deps) {
  const voice = deps.voice ?? {};
  const savedAnswers = voice.savedAnswers ?? [];
  return defineManifest({
    app: "triagedesk",
    billing: { gate: "subscription", isEntitled: deps.isEntitled, demoEmail: "demo@triagedesk.example" },
    tenants: { list: deps.listTenants, idForEmail: deps.idForEmail },
    schedule: { pass: "10 5 * * *", dispatch: "*/5 * * * *" },
    sources: [mailboxSource(deps.openMailbox)],
    actions: { reply: mailboxReplyAction(deps.openMailbox) },
    gates: [
      // Mail the team sent itself is not a customer message.
      (m) => (m.mailboxAddress && m.fromEmail === m.mailboxAddress ? stop("mail the team sent itself") : allow()),
      (m) => (m.fromEmail ? allow() : stop("no sender address to reply to")),
    ],
    steps: {
      classify: { capability: "triage", build: buildClassificationPrompt, parse: parseClassification },
      decide: decideByLabel({ labelOf: (c) => c.category, handoff: HANDOFF_CATEGORIES, ignore: NOISE_CATEGORIES }),
      draft: {
        capability: "reply",
        build: (input) => buildReplyDraftPrompt(input, voice),
        parse: (json, { item }) => parseDraft(json, item),
      },
      checkDraft: [
        (draft, item) => {
          const bad = unsupportedCommitments(`${draft.subject}\n${draft.body}`, sourceMaterialFor(item, savedAnswers));
          return bad.length ? `the draft commits to ${bad.join(", ")}, which is not in the message or the saved answers` : null;
        },
      ],
    },
    approval: {
      defaultMode: "copilot",
      // StarReply's classifier floor: a low-confidence read waits for a person even in autopilot.
      alwaysHold: [(_m, c) => (c && c.confidence < 0.7 ? `classification confidence ${c.confidence} is under 0.7` : null)],
      cleanApprovalsToUnlock: 10,
      undoSeconds: 120,
    },
    caps: { inferencePerDay: 200, actionsPerDay: 120, perThread: 3, perPass: 60 },
    state: {
      initial: "open",
      transition(s, e) {
        switch (e.type) {
          case "ignored":
            return "closed";
          case "stopped":
            return "closed";
          case "handoff":
          case "rejected":
          case "undone":
          case "blocked":
          case "failed":
            return "handoff";
          case "held":
            return "drafted";
          case "queued":
          case "approved":
            return "queued";
          case "sent":
            return "answered";
          default:
            return s === "answered" && e.type === "classified" ? "open" : null;
        }
      },
    },
    ledger: { events: "triagedesk_events", artifacts: "triagedesk_drafts", runs: "triagedesk_runs" },
  });
}
