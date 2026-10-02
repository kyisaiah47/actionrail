// Google's Gemini API, generateContent.

import { ProviderError, errorBody, type CompletionRequest, type CompletionResult, type FetchLike, type ModelProvider } from "./types.js";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /**
   * The thinking budget in tokens. Flash models default to 0 here, which keeps a short labelling
   * call fast and keeps thinking tokens out of the output budget. Pro models ignore 0, so it is
   * only sent when the model id contains "flash" or when you set it.
   */
  thinkingBudget?: number;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateResponse {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function geminiProvider(opts: GeminiOptions): ModelProvider {
  if (!opts.apiKey) throw new ProviderError("gemini", null, "an API key is required");
  const base = (opts.baseURL ?? GEMINI_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));

  return {
    name: "gemini",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = req.model ?? opts.model;
      const generationConfig: Record<string, unknown> = {};
      if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      if (req.json) generationConfig.responseMimeType = "application/json";
      const budget = opts.thinkingBudget ?? (/flash/i.test(model) ? 0 : undefined);
      if (budget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: budget };

      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig,
      };
      if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

      const res = await doFetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey, ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError("gemini", res.status, await errorBody(res));
      const data = (await res.json().catch(() => null)) as GenerateResponse | null;
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (!text) throw new ProviderError("gemini", res.status, "the response had no text part");
      return {
        text,
        model: data?.modelVersion ?? model,
        usage: { inputTokens: data?.usageMetadata?.promptTokenCount, outputTokens: data?.usageMetadata?.candidatesTokenCount },
      };
    },
  };
}
