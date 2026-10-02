// A SQL store for Postgres (node-postgres, PGlite, Supabase's Postgres) and SQLite (node:sqlite,
// better-sqlite3, Cloudflare D1 through an adapter). You pass a query function; ActionRail has no
// database driver dependency.
//
// `release_at` is a column, and the dispatcher's query predicates on it, so no code path can
// claim an artifact before its undo window closes. Conditional transitions are single UPDATE
// statements with RETURNING, so undo and the claim cannot both win.

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

export type SqlRow = Record<string, unknown>;
/** Runs one statement with `$1`-style parameters and returns its rows. */
export type SqlQuery = (sql: string, params: unknown[]) => Promise<SqlRow[]>;
export type SqlDialect = "postgres" | "sqlite";

export interface SqlTables {
  items: string;
  threads: string;
  watermarks: string;
  artifacts: string;
  events: string;
  usage: string;
  tenants: string;
  runs: string;
}

export const DEFAULT_TABLES: SqlTables = {
  items: "actionrail_items",
  threads: "actionrail_threads",
  watermarks: "actionrail_watermarks",
  artifacts: "actionrail_artifacts",
  events: "actionrail_events",
  usage: "actionrail_usage",
  tenants: "actionrail_tenants",
  runs: "actionrail_runs",
};

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function checkTables(t: SqlTables): SqlTables {
  for (const [k, v] of Object.entries(t)) {
    if (!TABLE_NAME.test(v)) throw new Error(`table name for ${k} must match ${TABLE_NAME}: "${v}"`);
  }
  return t;
}

/** A query function over node-postgres (Pool or Client) or PGlite. */
export function pgQuery(client: { query(sql: string, params?: unknown[]): Promise<{ rows: SqlRow[] }> }): SqlQuery {
  return async (sql, params) => (await client.query(sql, params)).rows;
}

/** A query function over node:sqlite's DatabaseSync or better-sqlite3. `$1` becomes `?1`. */
export function sqliteQuery(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }): SqlQuery {
  return async (sql, params) => db.prepare(sql.replace(/\$(\d+)/g, "?$1")).all(...params) as SqlRow[];
}

/** The CREATE statements for every table, one string per statement. */
export function schemaSql(dialect: SqlDialect, tables: Partial<SqlTables> = {}): string[] {
  const t = checkTables({ ...DEFAULT_TABLES, ...tables });
  const pg = dialect === "postgres";
  const json = pg ? "jsonb" : "text";
  const ts = pg ? "timestamptz" : "text";
  const bool = pg ? "boolean" : "integer";
  const real = pg ? "double precision" : "real";
  const seq = pg ? "seq bigint generated always as identity primary key" : "seq integer primary key autoincrement";
  const f = pg ? "false" : "0";
  return [
    `create table if not exists ${t.items} (
      id text primary key, app text not null, tenant_id text not null, provider text not null,
      external_id text not null, thread_key text not null, payload ${json} not null, item_cursor text,
      status text not null, reason text, classification ${json}, created_at ${ts} not null,
      unique (app, tenant_id, provider, external_id))`,
    `create table if not exists ${t.threads} (
      app text not null, tenant_id text not null, thread_key text not null, state text,
      action_count integer not null default 0, updated_at ${ts} not null,
      primary key (app, tenant_id, thread_key))`,
    `create table if not exists ${t.watermarks} (
      app text not null, tenant_id text not null, provider text not null, value text not null,
      updated_at ${ts} not null, primary key (app, tenant_id, provider))`,
    `create table if not exists ${t.artifacts} (
      id text primary key, app text not null, tenant_id text not null, item_id text not null,
      thread_key text not null, run_id text, kind text not null, payload ${json} not null,
      status text not null, reason text, release_at ${ts}, approved_at ${ts},
      approved_clean ${bool} not null default ${f}, edited ${bool} not null default ${f},
      fallback ${bool} not null default ${f}, amount ${real}, sent_at ${ts}, external_id text,
      created_at ${ts} not null, updated_at ${ts} not null)`,
    `create index if not exists ${t.artifacts}_due on ${t.artifacts} (app, status, release_at)`,
    `create index if not exists ${t.artifacts}_tenant on ${t.artifacts} (app, tenant_id, status)`,
    `create table if not exists ${t.events} (
      ${seq}, id text not null unique, app text not null, tenant_id text not null, run_id text,
      item_id text, artifact_id text, thread_key text, kind text not null, title text not null,
      detail text, evidence ${json} not null, occurred_at ${ts} not null)`,
    `create index if not exists ${t.events}_tenant on ${t.events} (app, tenant_id, seq)`,
    `create table if not exists ${t.usage} (
      app text not null, tenant_id text not null, capability text not null, provider text not null,
      model text not null, used_at ${ts} not null)`,
    `create index if not exists ${t.usage}_day on ${t.usage} (app, tenant_id, used_at)`,
    `create table if not exists ${t.tenants} (
      app text not null, tenant_id text not null, mode text not null,
      clean_approvals integer not null default 0, hold_over_threshold ${real},
      primary key (app, tenant_id))`,
    `create table if not exists ${t.runs} (
      id text primary key, app text not null, tenant_id text not null, status text not null,
      started_at ${ts} not null, finished_at ${ts}, summary ${json})`,
    `create unique index if not exists ${t.runs}_one_running on ${t.runs} (app, tenant_id) where status = 'running'`,
  ];
}

const PATCH_COLUMNS: Record<keyof ArtifactPatch, string> = {
  payload: "payload",
  reason: "reason",
  releaseAt: "release_at",
  approvedAt: "approved_at",
  approvedClean: "approved_clean",
  edited: "edited",
  sentAt: "sent_at",
  externalId: "external_id",
};

export interface SqlStoreOptions {
  query: SqlQuery;
  dialect: SqlDialect;
  tables?: Partial<SqlTables>;
}

export class SqlStore implements Store {
  readonly dialect: SqlDialect;
  readonly tables: SqlTables;
  private readonly q: SqlQuery;

  constructor(opts: SqlStoreOptions) {
    if (opts.dialect !== "postgres" && opts.dialect !== "sqlite") throw new Error(`unknown dialect "${String(opts.dialect)}"`);
    this.dialect = opts.dialect;
    this.q = opts.query;
    this.tables = checkTables({ ...DEFAULT_TABLES, ...(opts.tables ?? {}) });
  }

  /** The same database with this app's events, artifacts and runs tables. */
  scope(ledger: { events: string; artifacts: string; runs?: string }): SqlStore {
    return new SqlStore({
      query: this.q,
      dialect: this.dialect,
      tables: { ...this.tables, events: ledger.events, artifacts: ledger.artifacts, ...(ledger.runs ? { runs: ledger.runs } : {}) },
    });
  }

  /** Creates every table this store writes to, if it does not exist. */
  async migrate(): Promise<void> {
    for (const stmt of schemaSql(this.dialect, this.tables)) await this.q(stmt, []);
  }

  private run(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const p =
      this.dialect === "sqlite"
        ? params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v))
        : params.map((v) => (v === undefined ? null : v));
    return this.q(sql, p);
  }

  private j(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    return this.dialect === "sqlite" && typeof v === "string" ? JSON.parse(v) : v;
  }

  private toJson(v: unknown): string | null {
    return v === null || v === undefined ? null : JSON.stringify(v);
  }

  private iso(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
  }

  private item(r: SqlRow): ItemRecord {
    return {
      id: String(r.id),
      app: String(r.app),
      tenantId: String(r.tenant_id),
      provider: String(r.provider),
      externalId: String(r.external_id),
      threadKey: String(r.thread_key),
      payload: this.j(r.payload),
      cursor: (r.item_cursor as string | null) ?? null,
      status: r.status as ItemRecord["status"],
      reason: (r.reason as string | null) ?? null,
      classification: this.j(r.classification),
      createdAt: this.iso(r.created_at) as string,
    };
  }

  private artifact(r: SqlRow): ArtifactRecord {
    return {
      id: String(r.id),
      app: String(r.app),
      tenantId: String(r.tenant_id),
      itemId: String(r.item_id),
      threadKey: String(r.thread_key),
      runId: (r.run_id as string | null) ?? null,
      kind: String(r.kind),
      payload: this.j(r.payload),
      status: r.status as ArtifactStatus,
      reason: (r.reason as string | null) ?? null,
      releaseAt: this.iso(r.release_at),
      approvedAt: this.iso(r.approved_at),
      approvedClean: Boolean(Number(r.approved_clean)),
      edited: Boolean(Number(r.edited)),
      fallback: Boolean(Number(r.fallback)),
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      sentAt: this.iso(r.sent_at),
      externalId: (r.external_id as string | null) ?? null,
      createdAt: this.iso(r.created_at) as string,
      updatedAt: this.iso(r.updated_at) as string,
    };
  }

  private event(r: SqlRow): EventRecord {
    return {
      id: String(r.id),
      app: String(r.app),
      tenantId: String(r.tenant_id),
      runId: (r.run_id as string | null) ?? null,
      itemId: (r.item_id as string | null) ?? null,
      artifactId: (r.artifact_id as string | null) ?? null,
      threadKey: (r.thread_key as string | null) ?? null,
      kind: String(r.kind),
      title: String(r.title),
      detail: (r.detail as string | null) ?? null,
      evidence: (this.j(r.evidence) as EventRecord["evidence"]) ?? [],
      at: this.iso(r.occurred_at) as string,
    };
  }

  async recordItem(rec: Parameters<Store["recordItem"]>[0]) {
    const t = this.tables.items;
    const id = newId();
    const rows = await this.run(
      `insert into ${t} (id, app, tenant_id, provider, external_id, thread_key, payload, item_cursor, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'new', $9)
       on conflict (app, tenant_id, provider, external_id) do nothing returning *`,
      [id, rec.app, rec.tenantId, rec.provider, rec.externalId, rec.threadKey, this.toJson(rec.payload), rec.cursor, rec.createdAt],
    );
    if (rows.length) return { item: this.item(rows[0]), inserted: true };
    const existing = await this.run(
      `select * from ${t} where app = $1 and tenant_id = $2 and provider = $3 and external_id = $4`,
      [rec.app, rec.tenantId, rec.provider, rec.externalId],
    );
    if (!existing.length) throw new Error("recordItem: insert was skipped and no existing row was found");
    return { item: this.item(existing[0]), inserted: false };
  }

  async getItem(app: string, tenantId: string, itemId: string) {
    const rows = await this.run(`select * from ${this.tables.items} where app = $1 and tenant_id = $2 and id = $3`, [app, tenantId, itemId]);
    return rows.length ? this.item(rows[0]) : null;
  }

  async updateItem(app: string, tenantId: string, itemId: string, patch: Partial<Pick<ItemRecord, "status" | "reason" | "classification" | "payload">>) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if ("status" in patch) add("status", patch.status);
    if ("reason" in patch) add("reason", patch.reason);
    if ("classification" in patch) add("classification", this.toJson(patch.classification));
    if ("payload" in patch) add("payload", this.toJson(patch.payload));
    if (!sets.length) return;
    params.push(app, tenantId, itemId);
    const n = params.length;
    await this.run(`update ${this.tables.items} set ${sets.join(", ")} where app = $${n - 2} and tenant_id = $${n - 1} and id = $${n}`, params);
  }

  async getThread(app: string, tenantId: string, threadKey: string): Promise<ThreadRecord | null> {
    const rows = await this.run(`select * from ${this.tables.threads} where app = $1 and tenant_id = $2 and thread_key = $3`, [app, tenantId, threadKey]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      app: String(r.app),
      tenantId: String(r.tenant_id),
      threadKey: String(r.thread_key),
      state: (r.state as string | null) ?? null,
      actionCount: Number(r.action_count),
      updatedAt: this.iso(r.updated_at) as string,
    };
  }

  async saveThreadState(app: string, tenantId: string, threadKey: string, state: string, nowIso: string) {
    const t = this.tables.threads;
    await this.run(
      `insert into ${t} (app, tenant_id, thread_key, state, action_count, updated_at) values ($1, $2, $3, $4, 0, $5)
       on conflict (app, tenant_id, thread_key) do update set state = excluded.state, updated_at = excluded.updated_at`,
      [app, tenantId, threadKey, state, nowIso],
    );
  }

  async bumpThreadActions(app: string, tenantId: string, threadKey: string, nowIso: string) {
    const t = this.tables.threads;
    await this.run(
      `insert into ${t} (app, tenant_id, thread_key, state, action_count, updated_at) values ($1, $2, $3, null, 1, $4)
       on conflict (app, tenant_id, thread_key) do update set action_count = ${t}.action_count + 1, updated_at = excluded.updated_at`,
      [app, tenantId, threadKey, nowIso],
    );
  }

  async getWatermark(app: string, tenantId: string, provider: string) {
    const rows = await this.run(`select value from ${this.tables.watermarks} where app = $1 and tenant_id = $2 and provider = $3`, [app, tenantId, provider]);
    return rows.length ? String(rows[0].value) : null;
  }

  async setWatermark(app: string, tenantId: string, provider: string, value: string, nowIso: string) {
    await this.run(
      `insert into ${this.tables.watermarks} (app, tenant_id, provider, value, updated_at) values ($1, $2, $3, $4, $5)
       on conflict (app, tenant_id, provider) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [app, tenantId, provider, value, nowIso],
    );
  }

  async createArtifact(rec: Parameters<Store["createArtifact"]>[0]) {
    const rows = await this.run(
      `insert into ${this.tables.artifacts}
         (id, app, tenant_id, item_id, thread_key, run_id, kind, payload, status, reason, release_at, fallback, amount, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) returning *`,
      [
        newId(),
        rec.app,
        rec.tenantId,
        rec.itemId,
        rec.threadKey,
        rec.runId,
        rec.kind,
        this.toJson(rec.payload),
        rec.status,
        rec.reason,
        rec.releaseAt,
        rec.fallback,
        rec.amount,
        rec.createdAt,
      ],
    );
    return this.artifact(rows[0]);
  }

  async getArtifact(app: string, tenantId: string, artifactId: string) {
    const rows = await this.run(`select * from ${this.tables.artifacts} where app = $1 and tenant_id = $2 and id = $3`, [app, tenantId, artifactId]);
    return rows.length ? this.artifact(rows[0]) : null;
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
    if (!from.length) return null;
    const params: unknown[] = [to, nowIso];
    const sets = ["status = $1", "updated_at = $2"];
    for (const key of Object.keys(patch) as Array<keyof ArtifactPatch>) {
      const col = PATCH_COLUMNS[key];
      if (!col) continue;
      params.push(key === "payload" ? this.toJson(patch.payload) : patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
    params.push(app);
    const appIdx = params.length;
    params.push(artifactId);
    const idIdx = params.length;
    const fromIdx = from.map((s) => {
      params.push(s);
      return `$${params.length}`;
    });
    let where = `app = $${appIdx} and id = $${idIdx} and status in (${fromIdx.join(", ")})`;
    if (tenantId !== undefined) {
      params.push(tenantId);
      where += ` and tenant_id = $${params.length}`;
    }
    const rows = await this.run(`update ${this.tables.artifacts} set ${sets.join(", ")} where ${where} returning *`, params);
    return rows.length ? this.artifact(rows[0]) : null;
  }

  async listDueArtifacts(app: string, nowIso: string, limit: number) {
    const rows = await this.run(
      `select * from ${this.tables.artifacts} where app = $1 and status = 'queued' and release_at <= $2 order by release_at asc limit $3`,
      [app, nowIso, limit],
    );
    return rows.map((r) => this.artifact(r));
  }

  async listArtifacts(app: string, tenantId: string, opts: { status?: ArtifactStatus[]; limit?: number } = {}) {
    const params: unknown[] = [app, tenantId];
    let where = "app = $1 and tenant_id = $2";
    if (opts.status?.length) {
      const marks = opts.status.map((s) => {
        params.push(s);
        return `$${params.length}`;
      });
      where += ` and status in (${marks.join(", ")})`;
    }
    params.push(opts.limit ?? 200);
    const rows = await this.run(`select * from ${this.tables.artifacts} where ${where} order by created_at desc limit $${params.length}`, params);
    return rows.map((r) => this.artifact(r));
  }

  async countSentSince(app: string, tenantId: string, sinceIso: string) {
    const rows = await this.run(
      `select count(*) as n from ${this.tables.artifacts} where app = $1 and tenant_id = $2 and status = 'sent' and sent_at >= $3`,
      [app, tenantId, sinceIso],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async reclaimStaleSending(app: string, beforeIso: string, nowIso: string) {
    const rows = await this.run(
      `update ${this.tables.artifacts} set status = 'failed', reason = 'the dispatcher stopped mid send', updated_at = $1
       where app = $2 and status = 'sending' and updated_at <= $3 returning *`,
      [nowIso, app, beforeIso],
    );
    return rows.map((r) => this.artifact(r));
  }

  async appendEvents(rows: NewEvent[]) {
    if (!rows.length) return;
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      const vals = [
        newId(),
        r.app,
        r.tenantId,
        r.runId ?? null,
        r.itemId ?? null,
        r.artifactId ?? null,
        r.threadKey ?? null,
        r.kind,
        r.title,
        r.detail ?? null,
        this.toJson(r.evidence ?? []),
        r.at,
      ];
      const marks = vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${marks.join(", ")})`;
    });
    await this.run(
      `insert into ${this.tables.events}
         (id, app, tenant_id, run_id, item_id, artifact_id, thread_key, kind, title, detail, evidence, occurred_at)
       values ${tuples.join(", ")}`,
      params,
    );
  }

  async listEvents(app: string, tenantId: string, opts: { artifactId?: string; runId?: string; limit?: number } = {}) {
    const params: unknown[] = [app, tenantId];
    let where = "app = $1 and tenant_id = $2";
    if (opts.artifactId) {
      params.push(opts.artifactId);
      where += ` and artifact_id = $${params.length}`;
    }
    if (opts.runId) {
      params.push(opts.runId);
      where += ` and run_id = $${params.length}`;
    }
    let sql = `select * from ${this.tables.events} where ${where} order by seq asc`;
    if (opts.limit) {
      params.push(opts.limit);
      sql = `select * from (select * from ${this.tables.events} where ${where} order by seq desc limit $${params.length}) recent order by seq asc`;
    }
    return (await this.run(sql, params)).map((r) => this.event(r));
  }

  async recordInference(row: UsageRow) {
    await this.run(
      `insert into ${this.tables.usage} (app, tenant_id, capability, provider, model, used_at) values ($1, $2, $3, $4, $5, $6)`,
      [row.app, row.tenantId, row.capability, row.provider, row.model, row.at],
    );
  }

  async countInferenceSince(app: string, tenantId: string, sinceIso: string) {
    const rows = await this.run(`select count(*) as n from ${this.tables.usage} where app = $1 and tenant_id = $2 and used_at >= $3`, [app, tenantId, sinceIso]);
    return Number(rows[0]?.n ?? 0);
  }

  async getTenantSettings(app: string, tenantId: string): Promise<TenantSettings | null> {
    const rows = await this.run(`select * from ${this.tables.tenants} where app = $1 and tenant_id = $2`, [app, tenantId]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      mode: r.mode as Mode,
      cleanApprovals: Number(r.clean_approvals),
      holdOverThreshold: r.hold_over_threshold === null || r.hold_over_threshold === undefined ? null : Number(r.hold_over_threshold),
    };
  }

  async saveTenantSettings(app: string, tenantId: string, s: TenantSettings) {
    await this.run(
      `insert into ${this.tables.tenants} (app, tenant_id, mode, clean_approvals, hold_over_threshold) values ($1, $2, $3, $4, $5)
       on conflict (app, tenant_id) do update set mode = excluded.mode, clean_approvals = excluded.clean_approvals,
         hold_over_threshold = excluded.hold_over_threshold`,
      [app, tenantId, s.mode, s.cleanApprovals, s.holdOverThreshold],
    );
  }

  async adjustCleanApprovals(app: string, tenantId: string, delta: number, defaultMode: Mode) {
    const t = this.tables.tenants;
    const pg = this.dialect === "postgres";
    const max = pg ? "greatest" : "max";
    const d = pg ? "$4::integer" : "$4";
    const rows = await this.run(
      `insert into ${t} (app, tenant_id, mode, clean_approvals) values ($1, $2, $3, ${max}(0, ${d}))
       on conflict (app, tenant_id) do update set clean_approvals = ${max}(0, ${t}.clean_approvals + ${d})
       returning clean_approvals`,
      [app, tenantId, defaultMode, Math.trunc(delta)],
    );
    return Number(rows[0]?.clean_approvals ?? 0);
  }

  async startRun(app: string, tenantId: string, nowIso: string, staleBeforeIso: string) {
    const t = this.tables.runs;
    await this.run(
      `update ${t} set status = 'abandoned', finished_at = $1 where app = $2 and tenant_id = $3 and status = 'running' and started_at < $4`,
      [nowIso, app, tenantId, staleBeforeIso],
    );
    const rows = await this.run(
      `insert into ${t} (id, app, tenant_id, status, started_at) values ($1, $2, $3, 'running', $4) on conflict do nothing returning id`,
      [newId(), app, tenantId, nowIso],
    );
    return rows.length ? String(rows[0].id) : null;
  }

  async finishRun(app: string, runId: string, status: "done" | "failed", summary: unknown, nowIso: string) {
    await this.run(`update ${this.tables.runs} set status = $1, summary = $2, finished_at = $3 where app = $4 and id = $5`, [
      status,
      this.toJson(summary),
      nowIso,
      app,
      runId,
    ]);
  }
}
