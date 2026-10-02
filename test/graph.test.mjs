// The Microsoft Graph mailbox, against a scripted Graph. Nothing here reaches Microsoft.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GRAPH_SCOPES, graphMailbox, graphSendNew, mailboxSource, normalizeGraphMessage, stripQuotedReply } from "../dist/index.js";

const NOW = Date.parse("2026-10-02T05:00:00.000Z");

function tokenStore(grant) {
  const saved = [];
  return { saved, load: async () => grant, save: async (_t, g) => void saved.push(g) };
}

function scriptedGraph(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body, headers: init.headers });
    for (const [match, reply] of routes) {
      if (match(url, init)) {
        const r = typeof reply === "function" ? reply(url, init) : reply;
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ error: "unrouted" }), { status: 500 });
  };
  fn.calls = calls;
  return fn;
}

const grant = (over = {}) => ({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: NOW + 60 * 60 * 1000,
  app: "myapp",
  scopes: GRAPH_SCOPES,
  address: "Support@Acme.example",
  accountLabel: "Acme support",
  ...over,
});
const apps = { myapp: { clientId: "client-1", clientSecret: "client-secret-1" } };

describe("Graph mailbox", () => {
  it("opens no mailbox for a grant without Mail.ReadWrite or from an unknown app", async () => {
    const f = scriptedGraph([]);
    assert.equal(await graphMailbox("t", { tokens: tokenStore(grant({ scopes: "openid Mail.Send" })), apps, fetch: f, now: () => NOW }), null);
    assert.equal(await graphMailbox("t", { tokens: tokenStore(grant({ app: "other" })), apps, fetch: f, now: () => NOW }), null);
    assert.equal(f.calls.length, 0);
  });

  it("refreshes a token near expiry against its own app and keeps the marker, scopes and address", async () => {
    const tokens = tokenStore(grant({ expiresAt: NOW + 60 * 1000 }));
    const f = scriptedGraph([[(u) => u.includes("oauth2/v2.0/token"), { body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 } }]]);
    const box = await graphMailbox("t", { tokens, apps, fetch: f, now: () => NOW });
    assert.ok(box);
    const form = new URLSearchParams(f.calls[0].body);
    assert.equal(form.get("client_id"), "client-1");
    assert.equal(form.get("refresh_token"), "refresh-1");
    assert.equal(form.get("grant_type"), "refresh_token");
    const saved = tokens.saved[0];
    assert.equal(saved.accessToken, "access-2");
    assert.equal(saved.refreshToken, "refresh-2");
    assert.equal(saved.app, "myapp");
    assert.equal(saved.scopes, GRAPH_SCOPES);
    assert.equal(saved.address, "Support@Acme.example");
  });

  it("lists unread mail after the watermark, oldest first, as text, without drafts", async () => {
    const f = scriptedGraph([
      [
        (u) => u.includes("/mailFolders/inbox/messages"),
        {
          body: {
            value: [
              {
                id: "m1",
                conversationId: "c1",
                subject: "Hello",
                body: { contentType: "html", content: "<p>How do I export?</p><br>Thanks" },
                from: { emailAddress: { address: "Dana@Customer.example", name: "Dana" } },
                receivedDateTime: "2026-10-02T01:00:00Z",
                internetMessageHeaders: [{ name: "In-Reply-To", value: "<x@y>" }],
              },
              { id: "d1", isDraft: true },
            ],
          },
        },
      ],
    ]);
    const box = await graphMailbox("t", { tokens: tokenStore(grant()), apps, fetch: f, now: () => NOW });
    const msgs = await box.listUnreadSince(new Date("2026-10-01T00:00:00.000Z"), 500);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].fromEmail, "dana@customer.example");
    assert.equal(msgs[0].threadKey, "c1");
    assert.equal(msgs[0].inReplyTo, "<x@y>");
    assert.match(msgs[0].bodyText, /How do I export\?/);
    const url = decodeURIComponent(f.calls[0].url);
    assert.match(url, /isRead eq false and receivedDateTime gt 2026-10-01T00:00:00.000Z/);
    assert.match(url, /\$orderby=receivedDateTime asc/);
    assert.match(url, /\$top=100/, "the page size is clamped to 100");
    assert.equal(f.calls[0].headers.Authorization, "Bearer access-1");
    assert.equal(box.address, "support@acme.example");
  });

  it("throws on a failed list, so the source keeps the watermark", async () => {
    const f = scriptedGraph([[(u) => u.includes("/mailFolders/"), { status: 503, body: {} }]]);
    const tokens = tokenStore(grant());
    const box = await graphMailbox("t", { tokens, apps, fetch: f, now: () => NOW });
    await assert.rejects(box.listUnreadSince(null, 10), /503/);
    const source = mailboxSource(() => graphMailbox("t", { tokens, apps, fetch: f, now: () => NOW }), "microsoft365");
    const res = await source.listSince("t", "2026-10-01T00:00:00.000Z", { limit: 10 });
    assert.match(res.error, /503/);
  });

  it("replies in thread: createReply, then PATCH, then send, then marks the message read", async () => {
    const f = scriptedGraph([
      [(u, i) => u.endsWith("/m1/createReply") && i.method === "POST", { body: { id: "draft-1", internetMessageId: "<r1@acme>" } }],
      [(u, i) => u.endsWith("/messages/draft-1") && i.method === "PATCH", { status: 200, body: {} }],
      [(u, i) => u.endsWith("/draft-1/send"), { status: 202 }],
      [(u, i) => u.endsWith("/messages/m1") && i.method === "PATCH", { status: 200, body: {} }],
    ]);
    const box = await graphMailbox("t", { tokens: tokenStore(grant()), apps, fetch: f, now: () => NOW });
    const res = await box.replyTo("m1", { subject: "Re: Hello", body: "Open Reports." });
    assert.deepEqual(res, { ok: true, from: "Acme support", providerMessageId: "draft-1", internetMessageId: "<r1@acme>" });
    assert.deepEqual(
      f.calls.map((c) => `${c.method} ${c.url.split("/v1.0")[1]}`),
      ["POST /me/messages/m1/createReply", "PATCH /me/messages/draft-1", "POST /me/messages/draft-1/send", "PATCH /me/messages/m1"],
    );
    assert.deepEqual(JSON.parse(f.calls[1].body), { subject: "Re: Hello", body: { contentType: "Text", content: "Open Reports." } });
    assert.deepEqual(JSON.parse(f.calls[3].body), { isRead: true });
  });

  it("reports a refused send without marking anything read", async () => {
    const f = scriptedGraph([
      [(u) => u.endsWith("/createReply"), { body: { id: "draft-1" } }],
      [(u, i) => u.endsWith("/messages/draft-1") && i.method === "PATCH", { body: {} }],
      [(u) => u.endsWith("/send"), { status: 403, body: {} }],
    ]);
    const box = await graphMailbox("t", { tokens: tokenStore(grant()), apps, fetch: f, now: () => NOW });
    const res = await box.replyTo("m1", { subject: "s", body: "b" });
    assert.deepEqual(res, { ok: false, error: "graph-send-403" });
    assert.equal(f.calls.length, 3);
  });

  it("sends a new message by draft then send, and refuses example recipients", async () => {
    const f = scriptedGraph([
      [(u, i) => u.endsWith("/me/messages") && i.method === "POST", { body: { id: "n1", conversationId: "c9", internetMessageId: "<n1@acme>" } }],
      [(u) => u.endsWith("/n1/send"), { status: 202 }],
    ]);
    const opts = { tokens: tokenStore(grant()), apps, fetch: f, now: () => NOW };
    assert.deepEqual(await graphSendNew("t", { to: "x@sample.example", subject: "s", text: "t" }, opts), { ok: false, error: "example-recipient" });
    const res = await graphSendNew("t", { to: "client@customer.test", subject: "s", text: "t" }, opts);
    assert.equal(res.ok, true);
    assert.equal(res.conversationId, "c9");
  });

  it("normalises a message with no conversation into its own thread and strips quoted history", () => {
    const m = normalizeGraphMessage({ id: "solo", bodyPreview: "Yes please.\nOn Mon, Dana wrote:\n> old text" });
    assert.equal(m.threadKey, "solo");
    assert.equal(m.bodyText, "Yes please.");
    assert.equal(stripQuotedReply("> all quoted"), "> all quoted");
  });
});
