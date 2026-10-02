// AUTONOMY. Three levels, taken from the apps the engine was written from:
//
//   manual     every artifact waits in the queue, and a person sends each one.
//   copilot    every artifact waits for a tap. This is the default everywhere.
//   autopilot  artifacts queue by themselves, behind the undo window, unless a hold rule,
//              the amount threshold or a fallback result holds them.
//
// Autopilot is earned. A tenant can switch into it only after `cleanApprovalsToUnlock` approvals
// without an edit. An edit before approval does not count, and an undo takes a clean approval
// back. The count is a lifetime count, not a streak.

export type Mode = "manual" | "copilot" | "autopilot";

export const MODES: readonly Mode[] = ["manual", "copilot", "autopilot"];

export interface RouteInput {
  mode: Mode;
  /** Reasons from the manifest's alwaysHold rules. */
  holdReasons: string[];
  /** True when the classification or the draft came from a step's fallback. */
  fallback: boolean;
  /** The item's amount, when the manifest reads one. */
  amount: number | null;
  /** The tenant's autopilot hold threshold. */
  threshold: number | null;
}

export interface RouteResult {
  status: "held" | "queued";
  reasons: string[];
}

/**
 * Where a new artifact goes. A fallback result is held in every mode. Manual and copilot hold
 * everything. Autopilot queues only when no hold reason applies and the amount is at or under
 * the threshold.
 */
export function route(input: RouteInput): RouteResult {
  const reasons: string[] = [];
  if (input.fallback) reasons.push("a fallback result always waits for a person");
  if (input.mode === "manual") reasons.push("manual mode: a person sends every action");
  if (input.mode === "copilot") reasons.push("copilot mode: every action waits for a tap");
  reasons.push(...input.holdReasons);
  if (
    input.mode === "autopilot" &&
    input.amount !== null &&
    input.threshold !== null &&
    input.amount > input.threshold
  ) {
    reasons.push(`amount ${input.amount} is over the autopilot threshold of ${input.threshold}`);
  }
  return reasons.length ? { status: "held", reasons } : { status: "queued", reasons: [] };
}

/** True when a tenant may switch into autopilot. A tenant already in autopilot stays unlocked. */
export function autopilotUnlocked(current: Mode, cleanApprovals: number, needed: number): boolean {
  return current === "autopilot" || cleanApprovals >= needed;
}
