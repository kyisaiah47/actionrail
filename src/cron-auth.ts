// CRON AUTH. Every tick route calls this before it does any work.
//
// A request is the scheduler's only when it carries `Authorization: Bearer <secret>` and the
// secret is set to a non-blank value. An unset, empty or blank secret authorizes nobody, so a
// deployment that lost its secret refuses every caller instead of running for every caller.
//
// No other header is proof. Any caller can send `x-vercel-cron` or a similar header.
//
// The compare hashes both sides to 32 bytes first. timingSafeEqual then always compares equal
// lengths, and the time it takes does not depend on how much of the header matched.

import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function blank(secret: string | null | undefined): boolean {
  return typeof secret !== "string" || secret.trim() === "";
}

/** True only when `secret` is non-blank and `provided` equals it exactly. */
export function secretMatches(provided: string | null | undefined, secret: string | null | undefined): boolean {
  if (blank(secret) || typeof provided !== "string" || provided === "") return false;
  return timingSafeEqual(digest(provided), digest(secret as string));
}

/** True only when `secret` is non-blank and `authHeader` is exactly `Bearer <secret>`. */
export function cronAuthorized(authHeader: string | null | undefined, secret: string | null | undefined): boolean {
  if (blank(secret)) return false;
  return secretMatches(authHeader, `Bearer ${secret}`);
}

/** The request form. `secret` defaults to CRON_SECRET, read at call time. */
export function isCronRequest(req: Request, secret: string | undefined = process.env.CRON_SECRET): boolean {
  return cronAuthorized(req.headers.get("authorization"), secret);
}

/**
 * Wraps a tick for a route handler. It answers 401 before `run` is called unless the request
 * carries the bearer, and it answers 401 when the secret is unset.
 */
export async function cronRoute(
  req: Request,
  run: () => Promise<unknown>,
  secret: string | undefined = process.env.CRON_SECRET,
): Promise<Response> {
  if (!isCronRequest(req, secret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await run();
  return Response.json({ ok: true, result });
}
