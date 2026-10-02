// THE MAILBOX INTERFACE. The pass and the dispatcher talk to a shared inbox through these members
// and know nothing about which provider sits underneath. Microsoft Graph and the fake mailbox in
// this package both implement it, and `mailboxSource` / `mailboxReplyAction` turn any of them into
// the runner's source and action connectors.

import type { ActionConnector, SourceConnector } from "../manifest.js";

/** One inbound message, normalised off whichever provider produced it. */
export interface InboundMessage {
  /** The provider's own message id. The idempotency key for the whole loop. */
  id: string;
  /** RFC 5322 Message-ID, when the provider exposes it. */
  internetMessageId: string | null;
  /** The provider's conversation id. What groups a thread. */
  threadKey: string;
  subject: string | null;
  bodyText: string | null;
  fromEmail: string | null;
  fromName: string | null;
  receivedAt: string | null;
  inReplyTo: string | null;
  /** The connected mailbox's own address, so a gate can drop mail the team sent itself. */
  mailboxAddress?: string | null;
}

export interface SendResult {
  ok: boolean;
  /** The mailbox it went out as. */
  from?: string;
  providerMessageId?: string;
  internetMessageId?: string;
  error?: string;
}

export interface MailRail {
  provider: string;
  accountLabel: string;
  address: string | null;
  /**
   * Unread mail received strictly after `since`, oldest first. Throws on a provider failure, so
   * the runner keeps the watermark instead of reading a failure as a quiet night.
   */
  listUnreadSince(since: Date | null, limit: number): Promise<InboundMessage[]>;
  /** Replies to a message in its own thread, as the connected mailbox. */
  replyTo(messageId: string, reply: { subject: string; body: string }): Promise<SendResult>;
  /** Re-reads one message. Null when it no longer exists. */
  getMessage?(messageId: string): Promise<InboundMessage | null>;
}

/** A reply artifact: what the dispatcher sends through `mailboxReplyAction`. */
export interface ReplyArtifact {
  kind: "reply";
  /** The provider message id being answered. */
  replyTo: string;
  subject: string;
  body: string;
}

/** Opens the tenant's mailbox. Null when none is connected or the grant is too narrow. */
export type OpenMailbox = (tenantId: string) => Promise<MailRail | null>;

/** The runner source over a mailbox. Each message is an item; its received time is the cursor. */
export function mailboxSource(open: OpenMailbox, provider = "mailbox"): SourceConnector<InboundMessage> {
  return {
    provider,
    async listSince(tenantId, watermark, opts) {
      const rail = await open(tenantId);
      if (!rail) return { error: "no mailbox is connected, or its grant cannot read and reply" };
      try {
        const items = await rail.listUnreadSince(watermark ? new Date(watermark) : null, opts?.limit ?? 60);
        const withAddress = items.filter((m) => m.id).map((m) => ({ ...m, mailboxAddress: rail.address?.toLowerCase() ?? null }));
        return { items: withAddress, next: withAddress.at(-1)?.receivedAt ?? watermark };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    externalId: (m) => m.id,
    threadKey: (m) => m.threadKey || m.id,
    cursor: (m) => m.receivedAt,
    async refresh(tenantId, externalId) {
      const rail = await open(tenantId);
      if (!rail) throw new Error("no mailbox is connected");
      if (!rail.getMessage) return null;
      const m = await rail.getMessage(externalId);
      return m ? { ...m, mailboxAddress: rail.address?.toLowerCase() ?? null } : null;
    },
  };
}

/** The runner action that sends a ReplyArtifact in its thread. */
export function mailboxReplyAction(open: OpenMailbox, provider = "mailbox"): ActionConnector<ReplyArtifact> {
  return {
    provider,
    async perform(tenantId, a) {
      const rail = await open(tenantId);
      if (!rail) return { ok: false, reason: "no mailbox is connected" };
      const res = await rail.replyTo(a.replyTo, { subject: a.subject, body: a.body });
      return res.ok ? { ok: true, externalId: res.providerMessageId ?? res.internetMessageId } : { ok: false, reason: res.error ?? "the mailbox refused the send" };
    },
  };
}

/** Crude HTML to text for storage and classification. Text bodies pass through. */
export function htmlToText(content: string | null, contentType?: string): string | null {
  if (!content) return null;
  if ((contentType ?? "").toLowerCase() !== "html") return content;
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strips the quoted history a reply carries. Without this every message in a long thread is read
 * together with the whole thread pasted under it.
 */
export function stripQuotedReply(text: string | null): string | null {
  if (!text) return text;
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^\s*(>|On .{4,80} wrote:|-{2,}\s*Original Message|_{5,}|From:\s)/.test(l));
  const kept = cut > 0 ? lines.slice(0, cut) : lines;
  return kept.join("\n").trim() || text.trim();
}
