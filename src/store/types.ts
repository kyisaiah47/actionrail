// THE STORE. Everything the runner remembers goes through this interface: items, threads,
// watermarks, artifacts, the ledger, model usage, tenant settings and runs.
//
// Two implementations ship. MemoryStore keeps everything in the process and backs the tests and
// the examples. SqlStore writes to Postgres or SQLite through a query function you pass in.
// To run the engine on an app's existing tables, implement this interface over them.
//
// Every artifact move is a conditional transition that names the states it may come from and
// returns the row only when it moved. That is what makes undo and the dispatcher's claim safe
// against each other: exactly one of them finds the row in `queued`.

import type { Evidence } from "../manifest.js";
import type { Mode } from "../autonomy.js";

export type ItemStatus = "new" | "stopped" | "ignored" | "handoff" | "artifact";

export interface ItemRecord<Item = unknown, C = unknown> {
  id: string;
  app: string;
  tenantId: string;
  provider: string;
  externalId: string;
  threadKey: string;
  payload: Item;
  cursor: string | null;
  status: ItemStatus;
  reason: string | null;
  classification: C | null;
  createdAt: string;
}

export interface ThreadRecord {
  app: string;
  tenantId: string;
  threadKey: string;
  /** Null until the first transition, which means the manifest's initial state. */
  state: string | null;
  /** Actions performed in this thread. */
  actionCount: number;
  updatedAt: string;
}

export type ArtifactStatus =
  | "held"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled"
  | "rejected"
  | "blocked";

export interface ArtifactRecord<A = unknown> {
  id: string;
  app: string;
  tenantId: string;
  itemId: string;
  threadKey: string;
  runId: string | null;
  kind: string;
  payload: A;
  status: ArtifactStatus;
  /** Why it is held, blocked or failed. */
  reason: string | null;
  /** The earliest moment the dispatcher may claim it. */
  releaseAt: string | null;
  approvedAt: string | null;
  /** Approved by a person without an edit. Counts toward unlocking autopilot. */
  approvedClean: boolean;
  edited: boolean;
  /** Built from a step's fallback. Such an artifact is never queued without a person. */
  fallback: boolean;
  amount: number | null;
  sentAt: string | null;
  /** The action connector's own id for what it did. */
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ArtifactPatch<A = unknown> = Partial<
  Pick<
    ArtifactRecord<A>,
    "payload" | "reason" | "releaseAt" | "approvedAt" | "approvedClean" | "edited" | "sentAt" | "externalId"
  >
>;

export interface EventRecord {
  id: string;
  app: string;
  tenantId: string;
  runId: string | null;
  itemId: string | null;
  artifactId: string | null;
  threadKey: string | null;
  kind: string;
  title: string;
  detail: string | null;
  evidence: Evidence[];
  at: string;
}

export type NewEvent = Omit<EventRecord, "id" | "runId" | "itemId" | "artifactId" | "threadKey" | "detail" | "evidence"> &
  Partial<Pick<EventRecord, "runId" | "itemId" | "artifactId" | "threadKey" | "detail" | "evidence">>;

export interface UsageRow {
  app: string;
  tenantId: string;
  capability: string;
  provider: string;
  model: string;
  at: string;
}

export interface TenantSettings {
  mode: Mode;
  cleanApprovals: number;
  /** Overrides the manifest's autopilot hold threshold for this tenant. */
  holdOverThreshold: number | null;
}

export interface Store {
  /** A store bound to one app's ledger tables. MemoryStore returns itself. */
  scope?(ledger: { events: string; artifacts: string; runs?: string }): Store;

  /** Inserts the item unless (app, tenant, provider, externalId) exists. */
  recordItem(rec: Omit<ItemRecord, "id" | "status" | "reason" | "classification" | "createdAt"> & { createdAt: string }): Promise<{
    item: ItemRecord;
    inserted: boolean;
  }>;
  getItem(app: string, tenantId: string, itemId: string): Promise<ItemRecord | null>;
  updateItem(
    app: string,
    tenantId: string,
    itemId: string,
    patch: Partial<Pick<ItemRecord, "status" | "reason" | "classification" | "payload">>,
  ): Promise<void>;

  getThread(app: string, tenantId: string, threadKey: string): Promise<ThreadRecord | null>;
  saveThreadState(app: string, tenantId: string, threadKey: string, state: string, nowIso: string): Promise<void>;
  bumpThreadActions(app: string, tenantId: string, threadKey: string, nowIso: string): Promise<void>;

  getWatermark(app: string, tenantId: string, provider: string): Promise<string | null>;
  setWatermark(app: string, tenantId: string, provider: string, value: string, nowIso: string): Promise<void>;

  createArtifact(rec: Omit<ArtifactRecord, "id" | "updatedAt" | "sentAt" | "externalId" | "approvedAt" | "approvedClean" | "edited">): Promise<ArtifactRecord>;
  getArtifact(app: string, tenantId: string, artifactId: string): Promise<ArtifactRecord | null>;
  /**
   * Moves an artifact only when its status is one of `from`. Returns the moved row, or null when
   * it did not move. `tenantId` scopes the move when given.
   */
  transitionArtifact(
    app: string,
    artifactId: string,
    from: ArtifactStatus[],
    to: ArtifactStatus,
    patch: ArtifactPatch,
    nowIso: string,
    tenantId?: string,
  ): Promise<ArtifactRecord | null>;
  /** status = 'queued' AND release_at <= now, oldest release first. */
  listDueArtifacts(app: string, nowIso: string, limit: number): Promise<ArtifactRecord[]>;
  listArtifacts(app: string, tenantId: string, opts?: { status?: ArtifactStatus[]; limit?: number }): Promise<ArtifactRecord[]>;
  countSentSince(app: string, tenantId: string, sinceIso: string): Promise<number>;
  /** Moves rows stuck in `sending` since before `beforeIso` to `failed`. */
  reclaimStaleSending(app: string, beforeIso: string, nowIso: string): Promise<ArtifactRecord[]>;

  /** Writes ledger rows in order. Throws when the write fails. */
  appendEvents(rows: NewEvent[]): Promise<void>;
  /** Newest last. */
  listEvents(app: string, tenantId: string, opts?: { artifactId?: string; runId?: string; limit?: number }): Promise<EventRecord[]>;

  recordInference(row: UsageRow): Promise<void>;
  countInferenceSince(app: string, tenantId: string, sinceIso: string): Promise<number>;

  getTenantSettings(app: string, tenantId: string): Promise<TenantSettings | null>;
  saveTenantSettings(app: string, tenantId: string, settings: TenantSettings): Promise<void>;
  /** Adds `delta` to the clean approval count, never below zero, and returns the new count. */
  adjustCleanApprovals(app: string, tenantId: string, delta: number, defaultMode: Mode): Promise<number>;

  /**
   * Starts a pass for one tenant. Returns null when a pass for that tenant is already running and
   * started after `staleBeforeIso`. A running pass older than that is marked abandoned first.
   */
  startRun(app: string, tenantId: string, nowIso: string, staleBeforeIso: string): Promise<string | null>;
  finishRun(app: string, runId: string, status: "done" | "failed", summary: unknown, nowIso: string): Promise<void>;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}
