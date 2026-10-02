// The scrub gate fails closed. The private strings it guards are stored as fingerprints, so this
// test proves the fingerprint matcher on synthetic strings, and proves every pattern on strings
// built at run time. Nothing it must catch appears in this file as text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINGERPRINTS, PATTERNS, findFingerprints, fingerprint, scanText } from "../scripts/scrub-gate.mjs";

const GATE = new URL("../scripts/scrub-gate.mjs", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;

function gate(root) {
  return spawnSync(process.execPath, [GATE, root], { encoding: "utf8" });
}

function dirWith(content) {
  const dir = mkdtempSync(join(tmpdir(), "scrub-"));
  writeFileSync(join(dir, "clean.md"), "Nothing to see here.\n");
  if (content !== undefined) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "bad.ts"), `// header\nconst x = ${JSON.stringify(content)};\n`);
  }
  return dir;
}

const j = (...parts) => parts.join("");

const SHAPES = {
  "stripe account id": j("acct_", "1Q", "abcdefghijklmn"),
  "account DID": j("did:plc:", "abcdefghijklmnopqrstuvwx"),
  "anthropic key": j("sk-", "ant-", "a".repeat(30)),
  "google api key": j("AI", "za", "b".repeat(35)),
  "github token": j("gh", "p_", "c".repeat(36)),
  "stripe key": j("sk", "_live_", "d".repeat(24)),
  jwt: j("ey", "J", "a".repeat(12), ".ey", "J", "b".repeat(12), ".", "c".repeat(12)),
  "private key": j("-----BEGIN ", "RSA PRIVATE ", "KEY-----"),
  "stealth plugin": j("puppeteer", "-extra-plugin-", "stealth"),
  "captcha service": j("2cap", "tcha"),
  "webdriver override": j("Object.define", "Property(navigator, 'web", "driver', { get: () => false })"),
};

describe("scrub gate", () => {
  it("passes this repository", () => {
    const r = gate(REPO);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /clean/);
  });

  it("carries a fingerprint for every guarded private string", () => {
    const names = new Set(FINGERPRINTS.map((f) => f.name));
    for (const n of ["personal email", "local home path", "supabase project id", "stripe account id", "internal secret tool", "account DID", "account handle"]) {
      assert.ok(names.has(n), `${n} is guarded`);
    }
    assert.equal(FINGERPRINTS.filter((f) => f.name === "personal email").length, 6);
    assert.ok(PATTERNS.length > 20);
  });

  it("finds a fingerprinted string anywhere in a file, in any case, and nothing else", () => {
    const secret = j("someone", "@private", ".example");
    const prints = [fingerprint(secret, "test secret")];
    const text = `line one\nwrite to ${secret.toUpperCase()} today\n`;
    assert.deepEqual(findFingerprints(text, prints).map((f) => f.name), ["test secret"]);
    assert.deepEqual(scanText(text, prints).filter((f) => f.pattern === "test secret"), [{ pattern: "test secret", line: 2 }]);
    assert.deepEqual(findFingerprints("someone@private.exampl", prints), []);
    assert.deepEqual(findFingerprints(secret, prints).length, 1, "a match at the very end is found");
  });

  it("passes a clean directory", () => {
    assert.equal(gate(dirWith()).status, 0);
  });

  for (const [name, value] of Object.entries(SHAPES)) {
    it(`fails on ${name}`, () => {
      const r = gate(dirWith(value));
      assert.equal(r.status, 1, `${name} must fail the gate`);
      assert.match(r.stderr, new RegExp(`src/bad\\.ts:2: ${name}`));
    });
  }

  it("fails closed on an empty directory and on a missing one", () => {
    assert.equal(gate(mkdtempSync(join(tmpdir(), "scrub-empty-"))).status, 1);
    assert.equal(gate(join(tmpdir(), "actionrail-no-such-dir-here")).status, 1);
  });
});
