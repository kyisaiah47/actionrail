// A provider that never leaves the process. Tests and examples use it so that no run of the
// test suite reaches a paid model.

import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.js";

export type StubReply = string | Record<string, unknown> | Error;

export interface StubProvider extends ModelProvider {
  /** Every request the stub received, in order. */
  readonly calls: CompletionRequest[];
}

/**
 * `respond` gets each request and returns the text, an object (sent as JSON) or an Error (thrown,
 * as a provider failure would be).
 */
export function stubProvider(respond: (req: CompletionRequest) => StubReply | Promise<StubReply>, model = "stub-1"): StubProvider {
  const calls: CompletionRequest[] = [];
  return {
    name: "stub",
    model,
    calls,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      calls.push(req);
      const out = await respond(req);
      if (out instanceof Error) throw out;
      const text = typeof out === "string" ? out : JSON.stringify(out);
      return { text, model: req.model ?? model, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
