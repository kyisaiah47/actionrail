// An in-process store. It backs the tests and the examples, and it is the reference for what a
// store must do. Every method copies on the way in and out, so callers never share a row.

import type { Mode } from "../autonomy.js";
import {
  newId,
  type ArtifactPatch,
  type ArtifactRecord,
  type ArtifactStatus,
  type EventRecord,
  type ItemRecord,
  type NewEvent,
  type Store,
  type TenantSettings,
  type ThreadRecord,
  type UsageRow,
} from "./types.js";

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

interface RunRow {
  id: string;
  app: string;
  tenantId: string;
  status: "running" | "done" | "failed" | "abandoned";
  startedAt: string;
  finishedAt: string | null;
  summary: unknown;
}

export class MemoryStore implements Store {
  readonly items = new Map<string, ItemRecord>();
  readonly threads = new Map<string, ThreadRecord>();
  readonly watermarks = new Map<string, string>();
  readonly artifacts = new Map<string, ArtifactRecord>();
  readonly events: EventRecord[] = [];
  readonly usage: UsageRow[] = [];
  readonly tenants = new Map<string, TenantSettings>();
  readonly runs = new Map<string, RunRow>();

  scope(): Store {
    return this;
  }

  async recordItem(rec: Parameters<Store["recordItem"]>[0]) {
    const existing = [...this.items.values()].find(
      (i) => i.app === rec.app && i.tenantId === rec.tenantId && i.provider === rec.provider && i.externalId === rec.externalId,
    );
    if (existing) return { item: clone(existing), inserted: false };
    const item: ItemRecord = { ...clone(rec), id: newId(), status: "new", reason: null, classification: null };
    this.items.set(item.id, item);
    return { item: clone(item), inserted: true };
  }

  async getItem(app: string, tenantId: string, itemId: string) {
    const i = this.items.get(itemId);
    return i && i.app === app && i.tenantId === tenantId ? clone(i) : null;
  }

  async updateItem(app: string, tenantId: string, itemId: string, patch: Partial<Pick<ItemRecord, "status" | "reason" | "classification" | "payload">>) {
    const i = this.items.get(itemId);
    if (!i || i.app !== app || i.tenantId !== tenantId) return;
    Object.assign(i, clone(patch));
  }

  private tkey(app: string, tenantId: string, threadKey: string) {
    return JSON.stringify([app, tenantId, threadKey]);
  }

  async getThread(app: string, tenantId: string, threadKey: string) {
    return clone(this.threads.get(this.tkey(app, tenantId, threadKey)) ?? null);
  }

  async saveThreadState(app: string, tenantId: string, threadKey: string, state: string, nowIso: string) {
    const k = this.tkey(app, tenantId, threadKey);
    const t = this.threads.get(k) ?? { app, tenantId, threadKey, state: null, actionCount: 0, updatedAt: nowIso };
    this.threads.set(k, { ...t, state, updatedAt: nowIso });
  }

  async bumpThreadActions(app: string, tenantId: string, threadKey: string, nowIso: string) {
    const k = this.tkey(app, tenantId, threadKey);
    const t = this.threads.get(k) ?? { app, tenantId, threadKey, state: null, actionCount: 0, updatedAt: nowIso };
    this.threads.set(k, { ...t, actionCount: t.actionCount + 1, updatedAt: nowIso });
  }

  async getWatermark(app: string, tenantId: string, provider: string) {
    return this.watermarks.get(JSON.stringify([app, tenantId, provider])) ?? null;
  }

  async setWatermark(app: string, tenantId: string, provider: string, value: string) {
    this.watermarks.set(JSON.stringify([app, tenantId, provider]), value);
  }

  async createArtifact(rec: Parameters<Store["createArtifact"]>[0]) {
    const a: ArtifactRecord = {
      ...clone(rec),
      id: newId(),
      approvedAt: null,
      approvedClean: false,
      edited: false,
      sentAt: null,
      externalId: null,
      updatedAt: rec.createdAt,
    };
    this.artifacts.set(a.id, a);
    return clone(a);
  }

  async getArtifact(app: string, tenantId: string, artifactId: string) {
    const a = this.artifacts.get(artifactId);
    return a && a.app === app && a.tenantId === tenantId ? clone(a) : null;
  }

  async transitionArtifact(
    app: string,
    artifactId: string,
    from: ArtifactStatus[],
    to: ArtifactStatus,
    patch: ArtifactPatch,
    nowIso: string,
    tenantId?: string,
  ) {
    const a = this.artifacts.get(artifactId);
    if (!a || a.app !== app || (tenantId !== undefined && a.tenantId !== tenantId)) return null;
    if (!from.includes(a.status)) return null;
    Object.assign(a, clone(patch), { status: to, updatedAt: nowIso });
    return clone(a);
  }

  async listDueArtifacts(app: string, nowIso: string, limit: number) {
    return [...this.artifacts.values()]
      .filter((a) => a.app === app && a.status === "queued" && a.releaseAt !== null && a.releaseAt <= nowIso)
      .sort((x, y) => (x.releaseAt as string).localeCompare(y.releaseAt as string))
      .slice(0, limit)
      .map(clone);
  }

  async listArtifacts(app: string, tenantId: string, opts: { status?: ArtifactStatus[]; limit?: number } = {}) {
    return [...this.artifacts.values()]
      .filter((a) => a.app === app && a.tenantId === tenantId && (!opts.status || opts.status.includes(a.status)))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, opts.limit ?? 200)
      .map(clone);
  }

  async countSentSince(app: string, tenantId: string, sinceIso: string) {
    return [...this.artifacts.values()].filter(
      (a) => a.app === app && a.tenantId === tenantId && a.status === "sent" && a.sentAt !== null && a.sentAt >= sinceIso,
    ).length;
  }

  async reclaimStaleSending(app: string, beforeIso: string, nowIso: string) {
    const out: ArtifactRecord[] = [];
    for (const a of this.artifacts.values()) {
      if (a.app === app && a.status === "sending" && a.updatedAt <= beforeIso) {
        Object.assign(a, { status: "failed", reason: "the dispatcher stopped mid send", updatedAt: nowIso });
        out.push(clone(a));
      }
    }
    return out;
  }

  async appendEvents(rows: NewEvent[]) {
    for (const r of rows) {
      this.events.push({
        id: newId(),
        runId: null,
        itemId: null,
        artifactId: null,
        threadKey: null,
        detail: null,
        evidence: [],
        ...clone(r),
      });
    }
  }

  async listEvents(app: string, tenantId: string, opts: { artifactId?: string; runId?: string; limit?: number } = {}) {
    const rows = this.events.filter(
      (e) =>
        e.app === app &&
        e.tenantId === tenantId &&
        (!opts.artifactId || e.artifactId === opts.artifactId) &&
        (!opts.runId || e.runId === opts.runId),
    );
    return clone(opts.limit ? rows.slice(-opts.limit) : rows);
  }

  async recordInference(row: UsageRow) {
    this.usage.push(clone(row));
  }

  async countInferenceSince(app: string, tenantId: string, sinceIso: string) {
    return this.usage.filter((u) => u.app === app && u.tenantId === tenantId && u.at >= sinceIso).length;
  }

  async getTenantSettings(app: string, tenantId: string) {
    return clone(this.tenants.get(JSON.stringify([app, tenantId])) ?? null);
  }

  async saveTenantSettings(app: string, tenantId: string, settings: TenantSettings) {
    this.tenants.set(JSON.stringify([app, tenantId]), clone(settings));
  }

  async adjustCleanApprovals(app: string, tenantId: string, delta: number, defaultMode: Mode) {
    const k = JSON.stringify([app, tenantId]);
    const t = this.tenants.get(k) ?? { mode: defaultMode, cleanApprovals: 0, holdOverThreshold: null };
    t.cleanApprovals = Math.max(0, t.cleanApprovals + delta);
    this.tenants.set(k, t);
    return t.cleanApprovals;
  }

  async startRun(app: string, tenantId: string, nowIso: string, staleBeforeIso: string) {
    for (const r of this.runs.values()) {
      if (r.app === app && r.tenantId === tenantId && r.status === "running") {
        if (r.startedAt < staleBeforeIso) {
          r.status = "abandoned";
          r.finishedAt = nowIso;
        } else {
          return null;
        }
      }
    }
    const id = newId();
    this.runs.set(id, { id, app, tenantId, status: "running", startedAt: nowIso, finishedAt: null, summary: null });
    return id;
  }

  async finishRun(app: string, runId: string, status: "done" | "failed", summary: unknown, nowIso: string) {
    const r = this.runs.get(runId);
    if (!r || r.app !== app) return;
    Object.assign(r, { status, summary: clone(summary), finishedAt: nowIso });
  }
}
