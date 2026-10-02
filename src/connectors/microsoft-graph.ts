// THE MICROSOFT GRAPH MAILBOX. Read a shared inbox and reply in its own threads, as the mailbox.
//
// Written once from the two Graph mailbox integrations it replaces, FetchDue's and TriageDesk's.
// What they share, and what this keeps:
//   - the grant needs Mail.Send and Mail.ReadWrite. Mail.Send alone can fire a new message but
//     cannot read the inbox or thread a reply, so a narrower grant opens no mailbox at all;
//   - the access token is refreshed when under five minutes of life remain;
//   - refresh tokens are bound to the Entra app that minted them, so the credentials follow the
//     grant's app marker, and the marker, the scopes and the address survive every rotation.
//     Dropping any of them moves the grant onto the wrong registration and breaks send;
//   - a reply is createReply, then PATCH, then send, so it lands inside the customer's own
//     conversation with the threading headers filled in;
//   - the answered message is marked read, so the next pass does not pick it up again.
// One change from both: a failed list throws instead of returning an empty page, so the runner
// keeps the watermark rather than reading a provider failure as a quiet night.
//
// Token storage is yours. Implement GraphTokenStore over your own table, and encrypt the tokens
// at rest there.

import { htmlToText, stripQuotedReply, type InboundMessage, type MailRail, type SendResult } from "./mailbox.js";
import type { FetchLike } from "../providers/types.js";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

/** The scopes the loop needs: read the inbox, thread a reply, send it. */
export const GRAPH_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.ReadWrite",
].join(" ");

/** Refresh under five minutes of life. A Graph 401 costs more than a refresh. */
export const EXPIRY_SLACK_MS = 5 * 60 * 1000;

const MESSAGE_SELECT =
  "id,conversationId,internetMessageId,subject,body,bodyPreview,from,receivedDateTime,isDraft,internetMessageHeaders";

/** One tenant's Microsoft 365 grant, as your token store keeps it. */
export interface GraphGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The marker of the Entra app that minted these tokens. */
  app: string;
  /** The scope string the tokens were granted with. */
  scopes: string;
  /** The mailbox address, so the loop can drop mail the team sent itself. */
  address?: string | null;
  accountLabel?: string | null;
}

export interface GraphTokenStore {
  load(tenantId: string): Promise<GraphGrant | null>;
  save(tenantId: string, grant: GraphGrant): Promise<void>;
}

export interface EntraApp {
  clientId: string;
  clientSecret: string;
}

export interface GraphMailboxOptions {
  tokens: GraphTokenStore;
  /** Entra app credentials keyed by app marker. A grant refreshes only against its own app. */
  apps: Record<string, EntraApp>;
  fetch?: FetchLike;
  now?: () => number;
}

/** Thrown when Graph answers a read with an error. */
export class GraphError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GraphError";
    this.status = status;
  }
}

interface GraphMessageRaw {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  isDraft?: boolean;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}

/** True when the grant can run the loop: minted by a known app, with Mail.ReadWrite. */
export function mailboxSupportsInbound(grant: Pick<GraphGrant, "app" | "scopes">, knownApps: Iterable<string>): boolean {
  return new Set(knownApps).has(grant.app) && (grant.scopes ?? "").includes("Mail.ReadWrite");
}

/** Case-insensitive header lookup. */
export function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const h of headers) if ((h.name ?? "").toLowerCase() === wanted) return h.value ?? null;
  return null;
}

/** Graph message JSON to the loop's shape. */
export function normalizeGraphMessage(raw: GraphMessageRaw): InboundMessage {
  const headers = raw.internetMessageHeaders ?? [];
  return {
    id: raw.id ?? "",
    internetMessageId: raw.internetMessageId ?? null,
    // A message with no conversationId still gets a thread: its own id.
    threadKey: raw.conversationId ?? raw.id ?? "",
    subject: raw.subject ?? null,
    bodyText: stripQuotedReply(htmlToText(raw.body?.content ?? raw.bodyPreview ?? null, raw.body?.contentType)),
    fromEmail: raw.from?.emailAddress?.address?.toLowerCase() ?? null,
    fromName: raw.from?.emailAddress?.name ?? null,
    receivedAt: raw.receivedDateTime ?? null,
    inReplyTo: headerValue(headers, "In-Reply-To"),
  };
}

/** Reserved example domains are never sent to through a real mailbox. */
export function isExampleRecipient(address: string): boolean {
  return /@[^@]*\.example$/i.test(address.trim());
}

/**
 * Loads the tenant's grant, refreshing it when it is close to expiry, and returns a valid access
 * token. Null when there is no grant, the grant is too narrow, or the refresh fails.
 */
export async function graphAccessToken(tenantId: string, opts: GraphMailboxOptions): Promise<{ token: string; grant: GraphGrant } | null> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const grant = await opts.tokens.load(tenantId);
  if (!grant || !grant.accessToken) return null;
  // Fails closed: a Mail.Send-only grant cannot read the inbox, and an empty read would look like
  // a quiet night.
  if (!mailboxSupportsInbound(grant, Object.keys(opts.apps))) return null;
  if (grant.expiresAt - EXPIRY_SLACK_MS > now()) return { token: grant.accessToken, grant };

  const creds = opts.apps[grant.app];
  if (!grant.refreshToken || !creds) return null;
  const res = await doFetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      scope: grant.scopes || GRAPH_SCOPES,
    }).toString(),
  });
  if (!res.ok) return null;
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) return null;
  // The marker, the scopes and the address are carried across every rotation.
  const next: GraphGrant = {
    ...grant,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? grant.refreshToken,
    expiresAt: now() + (tok.expires_in ?? 3600) * 1000,
  };
  await opts.tokens.save(tenantId, next);
  return { token: next.accessToken, grant: next };
}

/** Opens the tenant's Graph mailbox as a MailRail, or null when it cannot run the loop. */
export async function graphMailbox(tenantId: string, opts: GraphMailboxOptions): Promise<MailRail | null> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const opened = await graphAccessToken(tenantId, opts);
  if (!opened) return null;
  const { token, grant } = opened;
  const auth = { Authorization: `Bearer ${token}` };
  const address = grant.address?.toLowerCase() ?? null;
  const accountLabel = grant.accountLabel ?? grant.address ?? "Microsoft 365";

  return {
    provider: "microsoft365",
    accountLabel,
    address,

    async listUnreadSince(since, limit) {
      // Filtered on the server, so a quiet night costs one small request.
      const filters = ["isRead eq false"];
      if (since) filters.push(`receivedDateTime gt ${since.toISOString()}`);
      const url =
        `${GRAPH_BASE}/me/mailFolders/inbox/messages` +
        `?$select=${MESSAGE_SELECT}` +
        `&$filter=${encodeURIComponent(filters.join(" and "))}` +
        `&$orderby=${encodeURIComponent("receivedDateTime asc")}` +
        `&$top=${Math.max(1, Math.min(100, limit))}`;
      const res = await doFetch(url, { headers: { ...auth, Prefer: 'outlook.body-content-type="text"' } });
      if (!res.ok) throw new GraphError(res.status, `graph list failed with ${res.status}`);
      const body = (await res.json().catch(() => null)) as { value?: GraphMessageRaw[] } | null;
      if (!body || !Array.isArray(body.value)) throw new GraphError(res.status, "graph list returned no value array");
      return body.value.filter((m) => m.id && !m.isDraft).map(normalizeGraphMessage);
    },

    async getMessage(messageId) {
      const res = await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}?$select=${MESSAGE_SELECT}`, {
        headers: { ...auth, Prefer: 'outlook.body-content-type="text"' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new GraphError(res.status, `graph read failed with ${res.status}`);
      return normalizeGraphMessage((await res.json()) as GraphMessageRaw);
    },

    async replyTo(messageId, reply): Promise<SendResult> {
      // createReply gives a draft inside the customer's conversation with recipients and the
      // References and In-Reply-To headers already filled in.
      const draftRes = await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/createReply`, {
        method: "POST",
        headers: { ...auth, "Content-Length": "0" },
      });
      if (!draftRes.ok) return { ok: false, error: `graph-createreply-${draftRes.status}` };
      const draft = (await draftRes.json().catch(() => ({}))) as { id?: string; internetMessageId?: string };
      if (!draft.id) return { ok: false, error: "graph-reply-no-id" };

      const patchRes = await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ subject: reply.subject, body: { contentType: "Text", content: reply.body } }),
      });
      if (!patchRes.ok) return { ok: false, error: `graph-patch-${patchRes.status}` };

      const sendRes = await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}/send`, {
        method: "POST",
        headers: { ...auth, "Content-Length": "0" },
      });
      if (sendRes.status !== 202) return { ok: false, error: `graph-send-${sendRes.status}` };

      // The thread is answered. Marking it read keeps the next pass from picking it up again.
      await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      }).catch(() => undefined);

      return { ok: true, from: accountLabel, providerMessageId: draft.id, internetMessageId: draft.internetMessageId };
    },
  };
}

/**
 * Sends a new message as the mailbox: create a draft, then send it, so the ids come back for
 * correlating replies later. Reserved example recipients are refused.
 */
export async function graphSendNew(
  tenantId: string,
  msg: { to: string; subject: string; text: string; html?: string },
  opts: GraphMailboxOptions,
): Promise<SendResult & { conversationId?: string }> {
  if (isExampleRecipient(msg.to)) return { ok: false, error: "example-recipient" };
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const opened = await graphAccessToken(tenantId, opts);
  if (!opened) return { ok: false, error: "no-mailbox" };
  const auth = { Authorization: `Bearer ${opened.token}` };
  const draftRes = await doFetch(`${GRAPH_BASE}/me/messages`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: msg.subject,
      body: msg.html ? { contentType: "HTML", content: msg.html } : { contentType: "Text", content: msg.text },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    }),
  });
  if (!draftRes.ok) return { ok: false, error: `graph-${draftRes.status}` };
  const draft = (await draftRes.json().catch(() => ({}))) as { id?: string; internetMessageId?: string; conversationId?: string };
  if (!draft.id) return { ok: false, error: "graph-draft-no-id" };
  const sendRes = await doFetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}/send`, {
    method: "POST",
    headers: { ...auth, "Content-Length": "0" },
  });
  if (sendRes.status !== 202) return { ok: false, error: `graph-${sendRes.status}` };
  return {
    ok: true,
    from: opened.grant.accountLabel ?? opened.grant.address ?? "Microsoft 365",
    providerMessageId: draft.id,
    internetMessageId: draft.internetMessageId,
    conversationId: draft.conversationId,
  };
}
