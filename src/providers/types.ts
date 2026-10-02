// THE PROVIDER INTERFACE. Every model step goes through one of these, and the user picks which.
// ActionRail ships drivers for OpenAI, Anthropic, Gemini and any OpenAI-compatible base URL,
// which covers a local model behind Ollama, LM Studio or vLLM. The drivers use fetch and have no
// SDK dependency. A key is passed in by the caller; no driver reads a key from the environment.

export interface CompletionRequest {
  system?: string;
  prompt: string;
  /** A model id for this call. Without one the provider's default model runs. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object, where it supports that. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  /** "openai", "anthropic", "gemini", "openai-compatible" or "stub". */
  readonly name: string;
  /** The default model id. */
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A provider answered with an error status or an unreadable body. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, status: number | null, message: string) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

/** True for statuses worth one more try: rate limits and server-side failures. */
export function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.status !== null && (err.status === 429 || err.status >= 500);
}

/** Reads an error body without throwing, on one line and trimmed for logs. */
export async function errorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}
