// Shared test fixtures. Every store the runner ships is exercised by the same tests: the in-memory
// store, SQLite through node:sqlite, and Postgres through PGlite, an in-process Postgres.

import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { MemoryStore, SqlStore, pgQuery, sqliteQuery } from "../dist/index.js";

export const STORES = [
  { name: "memory", make: async () => new MemoryStore() },
  {
    name: "sqlite",
    make: async () => {
      const store = new SqlStore({ dialect: "sqlite", query: sqliteQuery(new DatabaseSync(":memory:")) });
      return store;
    },
  },
  {
    name: "postgres",
    make: async () => {
      const db = new PGlite();
      await db.waitReady;
      return new SqlStore({ dialect: "postgres", query: pgQuery(db) });
    },
  },
];

/** A store migrated for a manifest's ledger tables, when it is a SQL store. */
export async function storeFor(kind, manifest) {
  const store = await kind.make();
  if (store instanceof SqlStore) {
    const scoped = manifest ? store.scope(manifest.ledger) : store;
    await scoped.migrate();
    return scoped;
  }
  return store;
}

export const at = (iso) => new Date(iso);
export const plus = (d, seconds) => new Date(d.getTime() + seconds * 1000);

/** A small source over an array, with optional failure and refresh. */
export function arraySource(provider = "list") {
  const items = [];
  const src = {
    provider,
    failNext: null,
    listCalls: 0,
    items,
    removed: new Set(),
    patched: new Map(),
    async listSince(_tenantId, watermark, opts) {
      src.listCalls += 1;
      if (src.failNext) {
        const e = src.failNext;
        src.failNext = null;
        return { error: e };
      }
      const out = items.filter((i) => !watermark || i.at > watermark).slice(0, opts?.limit ?? 100);
      return { items: out, next: out.at(-1)?.at ?? watermark };
    },
    externalId: (i) => i.id,
    threadKey: (i) => i.thread ?? i.id,
    cursor: (i) => i.at,
    async refresh(_tenantId, id) {
      if (src.removed.has(id)) return null;
      const base = items.find((i) => i.id === id) ?? null;
      return base ? { ...base, ...(src.patched.get(id) ?? {}) } : null;
    },
  };
  return src;
}

/** An action that records what it performed. */
export function recordingAction(provider = "sink") {
  const performed = [];
  const act = {
    provider,
    performed,
    refuse: null,
    throwError: null,
    onPerform: null,
    async perform(tenantId, artifact, ctx) {
      if (act.onPerform) await act.onPerform(tenantId, artifact, ctx);
      if (act.throwError) throw new Error(act.throwError);
      if (act.refuse) return { ok: false, reason: act.refuse };
      performed.push({ tenantId, artifact, ctx });
      return { ok: true, externalId: `ext-${performed.length}` };
    },
  };
  return act;
}
