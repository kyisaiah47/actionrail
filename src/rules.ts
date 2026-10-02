// RULE STEPS. Deterministic building blocks for apps whose core must not be a model call: a
// card-network decline gate, a scoring table whose length a landing page cites, a three-way match
// on tolerance, a clause read whose every value has a source span. Each one runs with no provider.

import { allow, stop, type Decision, type Gate, type Policy, type RuleStep } from "./manifest.js";

export interface LabelRule<I> {
  label: string;
  when(item: I): boolean;
  /** Shown in the ledger as the reason for the label. */
  because: string;
}

export interface RuleLabel {
  label: string;
  because: string;
  /** Always 1 for a rule that matched, 0 for the default. */
  confidence: number;
}

/** A classify step that returns the first matching rule's label, or the default. */
export function firstMatch<I>(rules: LabelRule<I>[], otherwise: string): RuleStep<I, RuleLabel> {
  return {
    kind: "rule",
    run(item) {
      for (const r of rules) if (r.when(item)) return { label: r.label, because: r.because, confidence: 1 };
      return { label: otherwise, because: "no rule matched", confidence: 0 };
    },
  };
}

export interface ScoreRule<I> {
  id: string;
  when(item: I): boolean;
  points: number;
  reason: string;
}

export interface Score {
  score: number;
  reasons: Array<{ id: string; points: number; reason: string }>;
}

/** A scoring table. Every point carries the rule that gave it. */
export function ruleTable<I>(rules: ScoreRule<I>[]): RuleStep<I, Score> {
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) throw new Error(`duplicate score rule id "${r.id}"`);
    ids.add(r.id);
  }
  return {
    kind: "rule",
    run(item) {
      const reasons = rules.filter((r) => r.when(item)).map((r) => ({ id: r.id, points: r.points, reason: r.reason }));
      return { score: reasons.reduce((s, r) => s + r.points, 0), reasons };
    },
  };
}

/** True when two figures agree within an absolute amount or a fraction of the larger one. */
export function withinTolerance(a: number, b: number, tol: { abs?: number; pct?: number }): boolean {
  const diff = Math.abs(a - b);
  if (tol.abs !== undefined && diff <= tol.abs) return true;
  if (tol.pct !== undefined && diff <= Math.max(Math.abs(a), Math.abs(b)) * tol.pct) return true;
  return tol.abs === undefined && tol.pct === undefined ? diff === 0 : false;
}

/**
 * A hard-stop gate on a code. Any code in `codes` stops the item for good, with no override.
 * CardChase's hard-decline codes are the model for this.
 */
export function hardStop<I>(codes: Iterable<string>, read: (item: I) => string | null | undefined, label = "hard stop"): Gate<I> {
  const set = new Set(codes);
  return (item) => {
    const code = read(item);
    return code && set.has(code) ? stop(`${label}: ${code}`, [{ kind: "rule", label: `${code} is a ${label} code` }]) : allow();
  };
}

/**
 * A decide function for apps that route by a label: some labels go to a person with no draft,
 * some are noise, the rest are drafted. A null classification goes to a person.
 */
export function decideByLabel<I, C, A>(opts: {
  labelOf(c: C): string;
  handoff: string[];
  ignore: string[];
}): (item: I, c: C | null, state: string, policy: Policy) => Decision<A> {
  const handoff = new Set(opts.handoff);
  const ignore = new Set(opts.ignore);
  return (_item, c) => {
    if (c === null) return { kind: "handoff", reason: "could_not_classify" };
    const label = opts.labelOf(c);
    if (ignore.has(label)) return { kind: "ignore", reason: label, evidence: [{ kind: "rule", label: `${label} is never answered` }] };
    if (handoff.has(label)) return { kind: "handoff", reason: label, evidence: [{ kind: "rule", label: `${label} always goes to a person` }] };
    return { kind: "stage" };
  };
}
