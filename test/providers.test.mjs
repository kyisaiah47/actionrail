// The provider drivers, with fetch replaced. No request in this file leaves the process, and no
// test reads a paid provider's key from the environment.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, anthropicProvider, createProvider, geminiProvider, openAIProvider, providerFromEnv } from "../dist/index.js";

function fakeFetch(reply, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const TEST_KEY = "test-key-not-real";

describe("OpenAI driver", () => {
  it("sends a chat completion with JSON mode and reads the message", async () => {
    const f = fakeFetch({ model: "gpt-x", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const p = openAIProvider({ apiKey: TEST_KEY, model: "gpt-x", fetch: f });
    const res = await p.complete({ system: "sys", prompt: "hi", maxTokens: 50, json: true });
    assert.equal(res.text, '{"ok":true}');
    assert.equal(res.usage.inputTokens, 5);
    const { url, init, body } = f.calls[0];
    assert.equal(new URL(url).host, "api.openai.com");
    assert.ok(url.endsWith("/chat/completions"));
    assert.equal(init.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(body.max_completion_tokens, 50);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(p.name, "openai");
  });

  it("reaches any OpenAI-compatible base URL, including a local model with no key", async () => {
    const f = fakeFetch({ choices: [{ message: { content: "{}" } }] });
    const p = createProvider({ provider: "openai-compatible", model: "llama3.1", baseURL: "http://localhost:11434/v1/", fetch: f });
    await p.complete({ prompt: "hi", maxTokens: 10, json: true });
    const { url, init, body } = f.calls[0];
    assert.equal(url, "http://localhost:11434/v1/chat/completions");
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(body.max_tokens, 10);
    assert.equal(body.response_format, undefined, "JSON mode is off by default for other servers");
    assert.equal(p.name, "openai-compatible");
  });

  it("throws a ProviderError on an error status", async () => {
    const p = openAIProvider({ apiKey: TEST_KEY, model: "m", fetch: fakeFetch({ error: "quota" }, 429) });
    await assert.rejects(p.complete({ prompt: "x" }), (err) => err instanceof ProviderError && err.status === 429);
  });

  it("refuses OpenAI with no key", () => {
    assert.throws(() => openAIProvider({ model: "m" }), ProviderError);
  });
});

describe("Anthropic driver", () => {
  it("sends a Messages request and joins the text blocks", async () => {
    const f = fakeFetch({ model: "claude-x", content: [{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }], usage: { input_tokens: 3, output_tokens: 4 } });
    const p = anthropicProvider({ apiKey: TEST_KEY, model: "claude-x", fetch: f });
    const res = await p.complete({ system: "sys", prompt: "hi" });
    assert.equal(res.text, '{"a":1}');
    const { url, init, body } = f.calls[0];
    assert.equal(new URL(url).host, "api.anthropic.com");
    assert.equal(init.headers["x-api-key"], TEST_KEY);
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    assert.equal(body.system, "sys");
    assert.equal(body.max_tokens, 1024, "Messages needs max_tokens, so a default is sent");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  });
});

describe("Gemini driver", () => {
  it("sends generateContent with JSON output and no thinking budget on Flash", async () => {
    const f = fakeFetch({ modelVersion: "gemini-2.5-flash", candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"x":1}' }] } }] });
    const p = geminiProvider({ apiKey: TEST_KEY, model: "gemini-2.5-flash", fetch: f });
    const res = await p.complete({ system: "sys", prompt: "hi", maxTokens: 40, json: true });
    assert.equal(res.text, '{"x":1}', "thought parts are left out");
    const { url, init, body } = f.calls[0];
    assert.ok(url.endsWith("/models/gemini-2.5-flash:generateContent"));
    assert.equal(init.headers["x-goog-api-key"], TEST_KEY);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "sys" }] });
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.maxOutputTokens, 40);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });

  it("leaves the thinking budget alone on other models", async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    await geminiProvider({ apiKey: TEST_KEY, model: "gemini-2.5-pro", fetch: f }).complete({ prompt: "x" });
    assert.equal(f.calls[0].body.generationConfig.thinkingConfig, undefined);
  });
});

describe("provider from the environment", () => {
  it("returns null when no provider is named, so rules-only apps need no model", () => {
    assert.equal(providerFromEnv({}), null);
  });
  it("builds the named provider from ACTIONRAIL_* variables only", () => {
    const p = providerFromEnv({ ACTIONRAIL_PROVIDER: "gemini", ACTIONRAIL_MODEL: "gemini-2.5-flash", ACTIONRAIL_API_KEY: TEST_KEY });
    assert.equal(p.name, "gemini");
    assert.equal(p.model, "gemini-2.5-flash");
    assert.throws(() => providerFromEnv({ ACTIONRAIL_PROVIDER: "gemini" }), /ACTIONRAIL_MODEL/);
    assert.throws(() => createProvider({ provider: "openai-compatible", model: "m" }), /baseURL/);
  });
});
