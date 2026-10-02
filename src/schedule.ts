// Five-field cron matching in UTC, so one scheduled tick can read every manifest and run the ones
// that are due. Fields: minute, hour, day of month, month, day of week (0 or 7 is Sunday).
// Each field takes *, a number, a range a-b, a step */n or a-b/n, and comma lists of those.

const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function fieldMatches(field: string, value: number, [lo, hi]: [number, number]): boolean {
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step "${part}"`);
    let from: number;
    let to: number;
    if (rangePart === "*") {
      from = lo;
      to = hi;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      from = a;
      to = b;
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : hi;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < lo || to > hi || from > to) {
      throw new Error(`bad cron field "${part}"`);
    }
    for (let v = from; v <= to; v += step) if (v === value) return true;
  }
  return false;
}

/** True when `expr` fires in the UTC minute that contains `now`. */
export function cronMatches(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron "${expr}" must have five fields`);
  const [min, hour, dom, mon, dow] = fields;
  const dowValue = now.getUTCDay();
  const dowOk = fieldMatches(dow, dowValue, BOUNDS[4]) || (dowValue === 0 && fieldMatches(dow, 7, BOUNDS[4]));
  const domOk = fieldMatches(dom, now.getUTCDate(), BOUNDS[2]);
  // Standard cron: when both day fields are restricted, either one matching is enough.
  const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
  return (
    fieldMatches(min, now.getUTCMinutes(), BOUNDS[0]) &&
    fieldMatches(hour, now.getUTCHours(), BOUNDS[1]) &&
    fieldMatches(mon, now.getUTCMonth() + 1, BOUNDS[3]) &&
    dayOk
  );
}
