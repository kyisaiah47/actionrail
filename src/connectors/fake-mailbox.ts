// A mailbox that lives in memory. Tests and the worked example run the whole loop against it:
// deliver messages, run a pass, approve, wait out the undo window, dispatch, and read what was
// sent. It implements the same MailRail interface as the Graph mailbox.

import type { InboundMessage, MailRail, SendResult } from "./mailbox.js";

export interface SentReply {
  replyTo: string;
  subject: string;
  body: string;
  providerMessageId: string;
}

export class FakeMailbox implements MailRail {
  readonly provider = "fake";
  readonly accountLabel: string;
  readonly address: string | null;
  readonly sent: SentReply[] = [];
  private readonly inbox: Array<InboundMessage & { read: boolean }> = [];
  private seq = 0;
  /** When set, the next list call throws, as a provider outage would. */
  failNextList: string | null = null;
  /** When set, every send is refused with this reason. */
  refuseSends: string | null = null;
  /** Called at the start of every send, before anything is recorded. */
  onSend: ((reply: { replyTo: string; subject: string; body: string }) => void | Promise<void>) | null = null;

  constructor(address: string | null = "support@example.com", accountLabel = "Example support inbox") {
    this.address = address;
    this.accountLabel = accountLabel;
  }

  /** Puts a message in the inbox, unread. Returns its id. */
  deliver(msg: Partial<InboundMessage> & { fromEmail: string; receivedAt: string }): string {
    this.seq += 1;
    const id = msg.id ?? `msg-${this.seq}`;
    this.inbox.push({
      id,
      internetMessageId: msg.internetMessageId ?? `<${id}@mail.example>`,
      threadKey: msg.threadKey ?? `thread-${id}`,
      subject: msg.subject ?? null,
      bodyText: msg.bodyText ?? null,
      fromEmail: msg.fromEmail.toLowerCase(),
      fromName: msg.fromName ?? null,
      receivedAt: msg.receivedAt,
      inReplyTo: msg.inReplyTo ?? null,
      read: false,
    });
    return id;
  }

  /** Removes a message, as a customer deleting it or a retention rule would. */
  remove(id: string): void {
    const i = this.inbox.findIndex((m) => m.id === id);
    if (i >= 0) this.inbox.splice(i, 1);
  }

  async listUnreadSince(since: Date | null, limit: number): Promise<InboundMessage[]> {
    if (this.failNextList) {
      const reason = this.failNextList;
      this.failNextList = null;
      throw new Error(reason);
    }
    const after = since?.toISOString() ?? null;
    return this.inbox
      .filter((m) => !m.read && (!after || (m.receivedAt ?? "") > after))
      .sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""))
      .slice(0, limit)
      .map(({ read: _read, ...m }) => ({ ...m }));
  }

  async getMessage(id: string): Promise<InboundMessage | null> {
    const m = this.inbox.find((x) => x.id === id);
    if (!m) return null;
    const { read: _read, ...rest } = m;
    return { ...rest };
  }

  async replyTo(messageId: string, reply: { subject: string; body: string }): Promise<SendResult> {
    if (this.onSend) await this.onSend({ replyTo: messageId, ...reply });
    if (this.refuseSends) return { ok: false, error: this.refuseSends };
    const original = this.inbox.find((m) => m.id === messageId);
    if (!original) return { ok: false, error: "the message being answered no longer exists" };
    const providerMessageId = `sent-${this.sent.length + 1}`;
    this.sent.push({ replyTo: messageId, subject: reply.subject, body: reply.body, providerMessageId });
    original.read = true;
    return { ok: true, from: this.accountLabel, providerMessageId };
  }
}
