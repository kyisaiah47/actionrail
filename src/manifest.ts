// THE MANIFEST. Each app hands the runner one of these, and the runner reads nothing else about
// the app. The shape follows the shared engine spec, section 4: billing, schedule, sources,
// actions, gates, steps, approval, caps, state and ledger.
//
// Three kinds of step can fill `classify` and `draft`:
//   - a ModelStep, which goes through the provider the user brings (OpenAI, Anthropic, Gemini or
//     any OpenAI-compatible base URL);
//   - a RuleStep, a deterministic function with no model call;
//   - a TemplateStep, a fixed text built from the item.
// An app with no ModelStep runs with no provider at all.

import type { Mode } from "./autonomy.js";

/** One checkable reason attached to a ledger row. */
export interface Evidence {
  kind: "quote" | "rule" | "cap" | "source" | "gate" | "model" | "state" | "receipt" | "amount";
  label: string;
}

/** What a hard gate says about an item. A stop is final for that item. */
export type GateVerdict = { stop: false } | { stop: true; reason: string; evidence?: Evidence[] };

/** Gates run in the pass, in approve and in the dispatcher. */
export type GatePhase = "pass" | "approve" | "dispatch";

export interface GateCtx {
  app: string;
  tenantId: string;
  now: Date;
  phase: GatePhase;
  /** The thread's current state. */
  threadState: string;
  /** Actions already performed in this thread. */
  threadActions: number;
}

export type Gate<Item> = (item: Item, ctx: GateCtx) => GateVerdict;

/** The gate verdict that lets an item through. */
export function allow(): GateVerdict {
  return { stop: false };
}

/** The gate verdict that stops an item for good. */
export function stop(reason: string, evidence?: Evidence[]): GateVerdict {
  return { stop: true, reason, evidence };
}

/** What `decide` returns for one item. */
export type Decision<Artifact> =
  /** Nothing else runs for this item, and the item is marked stopped. */
  | { kind: "stop"; reason: string; evidence?: Evidence[] }
  /** Noise. The item is recorded and nothing is drafted or sent. */
  | { kind: "ignore"; reason: string; evidence?: Evidence[] }
  /** A person takes this item. Nothing is drafted. */
  | { kind: "handoff"; reason: string; evidence?: Evidence[] }
  /** An action that needs no draft, for example a payment retry. */
  | { kind: "schedule"; artifact: Artifact; evidence?: Evidence[] }
  /** Run the draft step, then the draft checks, then route the draft. */
  | { kind: "stage"; evidence?: Evidence[] };

/** The policy `decide` sees for the tenant on this pass. */
export interface Policy {
  mode: Mode;
  undoSeconds: number;
  caps: Caps;
}

/** The prompt a ModelStep hands to the provider. */
export interface ModelPrompt {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/** The capability a model step stands for. The names match ParseRail's endpoints. */
export type Capability =
  | "classify"
  | "triage"
  | "reply"
  | "review-reply"
  | "dunning"
  | "contract"
  | "screen"
  | "po-match";

/**
 * A step served by a model. `build` returns the prompt, `parse` turns the model's JSON into the
 * step's output or returns null when the JSON does not fit. A null parse is retried once.
 *
 * `fallback` runs when the model is unavailable or its output never parses. A fallback result can
 * only route to `held`: the runner never queues it, in any mode.
 */
export interface ModelStep<I, O> {
  kind?: "model";
  capability: Capability;
  /** A model id for this step. Without one the provider's default model runs. */
  model?: string;
  build(input: I): ModelPrompt;
  parse(json: Record<string, unknown>, input: I): O | null;
  fallback?(input: I): O;
}

/** A deterministic step with no model call. */
export interface RuleStep<I, O> {
  kind: "rule";
  run(input: I): O | null;
}

/** A fixed text built from the input, with no model call. */
export interface TemplateStep<I, O> {
  kind: "template";
  render(input: I): O | null;
}

export type Step<I, O> = ModelStep<I, O> | RuleStep<I, O> | TemplateStep<I, O>;

export function isModelStep<I, O>(step: Step<I, O>): step is ModelStep<I, O> {
  return typeof (step as ModelStep<I, O>).build === "function";
}

/** A source pulls the tenant's items newer than its watermark. */
export interface SourceConnector<Item> {
  provider: string;
  /**
   * Items after `watermark`, oldest first. Return `{ error }` on any failure: the runner then
   * keeps every source's watermark where it was.
   */
  listSince(
    tenantId: string,
    watermark: string | null,
    opts?: { limit: number },
  ): Promise<{ items: Item[]; next: string | null } | { error: string }>;
  /** The provider's own id for the item. Items are unique on (tenant, provider, externalId). */
  externalId(item: Item): string;
  /** The thread the item belongs to. Defaults to its external id. */
  threadKey?(item: Item): string;
  /**
   * The watermark value of one item, for example its received time. With it the watermark moves
   * to the newest item actually recorded. Without it the watermark moves to `next` only when every
   * item returned was recorded.
   */
  cursor?(item: Item): string | null;
  /** Re-read one item so gates in approve and dispatch see current data. */
  refresh?(tenantId: string, externalId: string): Promise<Item | null>;
}

export type ActionResult = { ok: true; externalId?: string } | { ok: false; reason: string };

/** An action performs one approved artifact. A refusal is final and is never retried. */
export interface ActionConnector<Artifact> {
  provider: string;
  perform(tenantId: string, artifact: Artifact, ctx: { itemId: string; artifactId: string }): Promise<ActionResult>;
}

/** Events the runner feeds the thread state machine. */
export type StateEvent<C = unknown> =
  | { type: "classified"; classification: C | null }
  | { type: "stopped"; reason: string }
  | { type: "ignored"; reason: string }
  | { type: "handoff"; reason: string }
  | { type: "held" }
  | { type: "queued" }
  | { type: "approved" }
  | { type: "rejected" }
  | { type: "undone" }
  | { type: "sent" }
  | { type: "failed"; reason: string }
  | { type: "blocked"; reason: string };

export interface Caps {
  /** Model calls per tenant per UTC day. No ModelStep runs once it is reached. */
  inferencePerDay: number;
  /** Actions the dispatcher performs per tenant per UTC day. */
  actionsPerDay: number;
  /** Actions per thread. A thread at its cap goes to a person. */
  perThread?: number;
  /** Items one pass handles for one tenant. The watermark resumes the rest next pass. */
  perPass?: number;
}

export interface AgentManifest<Item, Artifact extends { kind: string }, State extends string, C = unknown> {
  /** The app name, stored on every row. */
  app: string;
  billing: {
    /** "subscription": the app's own plan check. "credits": a metered wallet the app checks. */
    gate: "subscription" | "credits";
    /** Only an entitled tenant gets a pass, an approval or a send. */
    isEntitled(tenantId: string): Promise<boolean>;
    /** The demo account. The runner never passes, approves or sends for it. */
    demoEmail: string;
  };
  /** Who the pass tick runs for. */
  tenants: {
    list(): Promise<string[]>;
    /** Resolves the demo email. A thrown error stops the pass, so the demo is never run by mistake. */
    idForEmail(email: string): Promise<string | null>;
  };
  schedule: {
    /** Cron for the pass, in UTC, for example "10 5 * * *". */
    pass: string;
    /** Cron for the dispatcher, for example "*\/5 * * * *". */
    dispatch: string;
  };
  sources: SourceConnector<Item>[];
  /** Keyed by artifact kind. */
  actions: Record<string, ActionConnector<Artifact>>;
  /** Pure checks. They run in the pass, in approve and in the dispatcher. */
  gates: Gate<Item>[];
  steps: {
    classify?: Step<Item, C>;
    decide(item: Item, c: C | null, state: State, policy: Policy): Decision<Artifact>;
    draft?: Step<{ item: Item; c: C | null }, Artifact>;
    /** Each returns a reason to refuse the draft, or null. A refused draft goes to a person. */
    checkDraft?: Array<(draft: Artifact, item: Item) => string | null>;
  };
  approval: {
    defaultMode: Mode;
    /** Each returns a reason to hold, or null. A hold reason wins over autopilot. */
    alwaysHold: Array<(item: Item, c: C | null) => string | null>;
    /** The item's amount. In autopilot an amount over the tenant's threshold waits for a tap. */
    holdOverAmount?: (item: Item) => number;
    /** The default autopilot threshold for `holdOverAmount`. */
    holdOverThreshold?: number;
    /** Clean approvals a tenant needs before it can switch to autopilot. */
    cleanApprovalsToUnlock: number;
    /** Seconds between approval and the earliest send. Undo works inside this window. */
    undoSeconds: number;
  };
  caps: Caps;
  state: {
    initial: State;
    /** The next state, or null when the move is not allowed. Null changes nothing. */
    transition(s: State, e: StateEvent<C>): State | null;
  };
  /** Table names the SQL store writes to for this app. */
  ledger: { events: string; artifacts: string; runs?: string };
}

/** Any manifest, for code that does not care about its type parameters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyManifest = AgentManifest<any, any, any, any>;

const CRON_FIELD = /^[\d*\/,-]+$/;

/**
 * Checks a manifest's shape and returns it unchanged. It throws on the mistakes that would make
 * the runner unsafe: no undo window, a cap of zero or below, a draft step with no action for it,
 * or a schedule that is not a five-field cron.
 */
export function defineManifest<Item, Artifact extends { kind: string }, State extends string, C = unknown>(
  m: AgentManifest<Item, Artifact, State, C>,
): AgentManifest<Item, Artifact, State, C> {
  const problems: string[] = [];
  if (!m.app || !/^[a-z0-9][a-z0-9_-]*$/.test(m.app)) problems.push("app must be a lowercase slug");
  if (!m.billing || typeof m.billing.isEntitled !== "function") problems.push("billing.isEntitled is required");
  if (!m.billing?.demoEmail) problems.push("billing.demoEmail is required");
  if (!m.tenants || typeof m.tenants.list !== "function" || typeof m.tenants.idForEmail !== "function") {
    problems.push("tenants.list and tenants.idForEmail are required");
  }
  for (const key of ["pass", "dispatch"] as const) {
    const expr = m.schedule?.[key];
    const fields = typeof expr === "string" ? expr.trim().split(/\s+/) : [];
    if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) problems.push(`schedule.${key} must be a five-field cron`);
  }
  if (!Array.isArray(m.sources) || m.sources.length === 0) problems.push("at least one source is required");
  if (!m.actions || Object.keys(m.actions).length === 0) problems.push("at least one action is required");
  if (!Array.isArray(m.gates)) problems.push("gates must be an array (it may be empty)");
  if (typeof m.steps?.decide !== "function") problems.push("steps.decide is required");
  const a = m.approval;
  if (!a) problems.push("approval is required");
  else {
    if (!["manual", "copilot", "autopilot"].includes(a.defaultMode)) problems.push("approval.defaultMode must be manual, copilot or autopilot");
    if (!Number.isFinite(a.undoSeconds) || a.undoSeconds <= 0) problems.push("approval.undoSeconds must be above zero");
    if (!Number.isInteger(a.cleanApprovalsToUnlock) || a.cleanApprovalsToUnlock < 0) problems.push("approval.cleanApprovalsToUnlock must be a whole number");
    if (!Array.isArray(a.alwaysHold)) problems.push("approval.alwaysHold must be an array (it may be empty)");
  }
  const c = m.caps;
  if (!c) problems.push("caps are required");
  else {
    for (const key of ["inferencePerDay", "actionsPerDay", "perThread", "perPass"] as const) {
      const v = c[key];
      if (v === undefined && (key === "perThread" || key === "perPass")) continue;
      if (!Number.isInteger(v) || (v as number) < 1) problems.push(`caps.${key} must be a whole number of at least 1`);
    }
  }
  if (!m.state || typeof m.state.transition !== "function" || !m.state.initial) problems.push("state.initial and state.transition are required");
  if (!m.ledger?.events || !m.ledger?.artifacts) problems.push("ledger.events and ledger.artifacts are required");
  if (problems.length) throw new Error(`Invalid manifest for "${m.app}": ${problems.join("; ")}`);
  return m;
}
