// Tolerant JSON parsing for model output. Models wrap JSON in code fences or add a sentence
// around it, so this strips fences and, failing a direct parse, reads the outermost object.

export function parseModelJson(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const direct = tryObject(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return tryObject(trimmed.slice(start, end + 1));
}

function tryObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
