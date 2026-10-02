// Anthropic's Messages API.

import { ProviderError, errorBody, type CompletionRequest, type CompletionResult, type FetchLike, type ModelProvider } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Messages API requires max_tokens. This is used when a step does not set one. */
  defaultMaxTokens?: number;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

interface MessagesResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicProvider(opts: AnthropicOptions): ModelProvider {
  if (!opts.apiKey) throw new ProviderError("anthropic", null, "an API key is required");
  const base = (opts.baseURL ?? ANTHROPIC_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));

  return {
    name: "anthropic",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const body: Record<string, unknown> = {
        model: req.model ?? opts.model,
        max_tokens: req.maxTokens ?? opts.defaultMaxTokens ?? 1024,
        messages: [{ role: "user", content: req.prompt }],
      };
      if (req.system) body.system = req.system;
      if (req.temperature !== undefined) body.temperature = req.temperature;

      const res = await doFetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError("anthropic", res.status, await errorBody(res));
      const data = (await res.json().catch(() => null)) as MessagesResponse | null;
      const text = (data?.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (!text) throw new ProviderError("anthropic", res.status, "the response had no text block");
      return {
        text,
        model: data?.model ?? String(body.model),
        usage: { inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens },
      };
    },
  };
}
