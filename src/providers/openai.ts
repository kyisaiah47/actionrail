// OpenAI Chat Completions, and every server that speaks the same API at another base URL:
// Ollama, LM Studio, vLLM, OpenRouter, Together, Groq and Gemini's OpenAI endpoint among them.

import { ProviderError, errorBody, type CompletionRequest, type CompletionResult, type FetchLike, type ModelProvider } from "./types.js";

export interface OpenAIOptions {
  apiKey?: string;
  model: string;
  /** Defaults to OpenAI's own API. Set it to reach any compatible server. */
  baseURL?: string;
  /** Send `response_format: json_object` when a step asks for JSON. On by default for OpenAI. */
  jsonMode?: boolean;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** Shown in ledger rows and errors. */
  name?: string;
}

const OPENAI_BASE = "https://api.openai.com/v1";

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openAIProvider(opts: OpenAIOptions): ModelProvider {
  const base = (opts.baseURL ?? OPENAI_BASE).replace(/\/+$/, "");
  const isOpenAI = !opts.baseURL || base === OPENAI_BASE;
  const name = opts.name ?? (isOpenAI ? "openai" : "openai-compatible");
  const jsonMode = opts.jsonMode ?? isOpenAI;
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  if (isOpenAI && !opts.apiKey) throw new ProviderError(name, null, "an API key is required");

  return {
    name,
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const messages = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.prompt },
      ];
      const body: Record<string, unknown> = { model: req.model ?? opts.model, messages };
      if (req.maxTokens !== undefined) body[isOpenAI ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.json && jsonMode) body.response_format = { type: "json_object" };

      const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const res = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(name, res.status, await errorBody(res));
      const data = (await res.json().catch(() => null)) as ChatResponse | null;
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new ProviderError(name, res.status, "the response had no message content");
      return {
        text,
        model: data?.model ?? String(body.model),
        usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens },
      };
    },
  };
}
