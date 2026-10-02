// Day boundaries and cap checks. Every daily cap counts from midnight UTC.

/** Midnight UTC of the day `now` falls in, as an ISO string. */
export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** True once `used` has reached `cap`. Checked before the work, so the work never runs over. */
export function capReached(used: number, cap: number | undefined): boolean {
  return cap !== undefined && used >= cap;
}

/** `now` plus a number of seconds, as an ISO string. */
export function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
