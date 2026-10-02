// One entry point for every driver. The caller names the provider and passes its own key.

import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { openAIProvider } from "./openai.js";
import type { FetchLike, ModelProvider } from "./types.js";

export type ProviderKind = "openai" | "anthropic" | "gemini" | "openai-compatible";

export interface ProviderConfig {
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  /** Required for "openai-compatible". Optional for the others. */
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

export function createProvider(cfg: ProviderConfig): ModelProvider {
  switch (cfg.provider) {
    case "openai":
      return openAIProvider({ apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseURL, headers: cfg.headers, fetch: cfg.fetch });
    case "openai-compatible":
      if (!cfg.baseURL) throw new Error("openai-compatible needs a baseURL, for example http://localhost:11434/v1");
      return openAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseURL: cfg.baseURL,
        headers: cfg.headers,
        fetch: cfg.fetch,
        name: "openai-compatible",
      });
    case "anthropic":
      return anthropicProvider({ apiKey: cfg.apiKey ?? "", model: cfg.model, baseURL: cfg.baseURL, headers: cfg.headers, fetch: cfg.fetch });
    case "gemini":
      return geminiProvider({ apiKey: cfg.apiKey ?? "", model: cfg.model, baseURL: cfg.baseURL, headers: cfg.headers, fetch: cfg.fetch });
    default:
      throw new Error(`unknown provider "${String((cfg as { provider: unknown }).provider)}"`);
  }
}

/**
 * Builds a provider from ACTIONRAIL_PROVIDER, ACTIONRAIL_MODEL, ACTIONRAIL_API_KEY and
 * ACTIONRAIL_BASE_URL. Returns null when ACTIONRAIL_PROVIDER is unset, so an app with only rule
 * and template steps runs with no model at all.
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): ModelProvider | null {
  const kind = env.ACTIONRAIL_PROVIDER?.trim();
  if (!kind) return null;
  const model = env.ACTIONRAIL_MODEL?.trim();
  if (!model) throw new Error("ACTIONRAIL_MODEL is required when ACTIONRAIL_PROVIDER is set");
  return createProvider({
    provider: kind as ProviderKind,
    model,
    apiKey: env.ACTIONRAIL_API_KEY?.trim() || undefined,
    baseURL: env.ACTIONRAIL_BASE_URL?.trim() || undefined,
  });
}
