#!/usr/bin/env node
// THE SCRUB GATE. Fails closed when the repo carries anything that must never be public:
// personal email addresses, a local home path, a hosted project id, account ids, internal secret
// tools, account handles and DIDs, key-shaped strings, or bot-detection bypass code.
//
//   node scripts/scrub-gate.mjs [root]
//
// It scans every file git tracks or would add (tracked plus untracked, minus .gitignore), and
// falls back to a walk when the root is not a git checkout. It exits 1 on any finding, when it
// cannot read a file, and when it finds no files at all. There is no allowlist and no flag that
// lets a finding through.
//
// Two kinds of check:
//   - FINGERPRINTS. Specific private strings (email addresses, a project id, handles) are stored
//     as a rolling hash and a SHA-256 prefix, never as text, so this public file does not publish
//     what it guards. Matching is case-insensitive.
//   - PATTERNS. Shapes that are not secret in themselves: key formats, bot-detection bypass
//     packages, webdriver overrides. Each literal carries a character class, so the source text of
//     this file does not match itself.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const B = 257;
const M = 2147483647;

/** The fingerprint of one literal: its length, a rolling hash and a SHA-256 prefix. */
export function fingerprint(literal, name = "literal") {
  const s = literal.toLowerCase();
  let rh = 0;
  for (let i = 0; i < s.length; i++) rh = (rh * B + s.charCodeAt(i)) % M;
  return { name, len: s.length, rh, sha: createHash("sha256").update(s, "latin1").digest("hex").slice(0, 32) };
}

export const FINGERPRINTS = [
  { name: "personal email", len: 16, rh: 648711936, sha: "bacb5f1eb38633d7e8c894356d2c5024" },
  { name: "personal email", len: 11, rh: 1537020640, sha: "51579a5024dce403793a5872bcd84a21" },
  { name: "personal email", len: 13, rh: 1588454479, sha: "739b55edfb543ab7f381df8ac016ba26" },
  { name: "personal email", len: 14, rh: 1675355247, sha: "a80f263e389ad5232375bce5b4edca75" },
  { name: "personal email", len: 14, rh: 1367341493, sha: "6ef68a1d5ed487ad51067d76acb87b5a" },
  { name: "personal email", len: 8, rh: 1909635734, sha: "66cfae414570404938318bf69146074f" },
  { name: "local home path", len: 12, rh: 427670548, sha: "39ab698794f5d0b02c6f42e58bf28f50" },
  { name: "supabase project id", len: 20, rh: 213512414, sha: "41f5de058b2a5859451df101ca9b7bc0" },
  { name: "stripe account id", len: 7, rh: 6910140, sha: "3709a3cf62ab18427610119ce148b4ff" },
  { name: "internal secret tool", len: 15, rh: 848435131, sha: "4d9203f0461c350eb8100826f9d41951" },
  { name: "internal secret tool", len: 14, rh: 398134600, sha: "52d574851fe7dcf24427dc68898c1bee" },
  { name: "account DID", len: 32, rh: 739028264, sha: "b09167328f9badbc927629d79aaaf45a" },
  { name: "account DID", len: 32, rh: 674193979, sha: "f884634f04010c3fbec25bc9a6aadd9c" },
  { name: "account handle", len: 16, rh: 105245237, sha: "e2836199cfab1f9c48df329c72f3edc1" },
  { name: "account handle", len: 16, rh: 740808439, sha: "39a0cb030d768ef8ea7f16b1222a7606" },
  { name: "account handle", len: 16, rh: 876869625, sha: "0fd45213edd677a9adc59bafe45bae94" },
  { name: "account handle", len: 13, rh: 1599498843, sha: "febb366ba24fd7bdd94bbd205ad1996c" },
  { name: "account handle", len: 11, rh: 1163338482, sha: "a4118d819c7547b16c232d3611ccc09e" },
  { name: "account handle", len: 27, rh: 1274998365, sha: "a4c3b652a28e06e7c5287714ae80e0f2" },
  { name: "account handle", len: 13, rh: 780145877, sha: "3a0e52ccc2254ebca7256e69f2095005" },
  { name: "account handle", len: 11, rh: 1540124420, sha: "8e325fd979479aa192acb6414e62799d" },
  { name: "account handle", len: 11, rh: 443194149, sha: "7327751d474f3cca55c8a93119ec4349" },
];

export const PATTERNS = [
  // Account ids and DIDs of any value.
  { name: "stripe account id", re: /\bacct_1[0-9A-Za-z]{12,}/ },
  { name: "account DID", re: /did:plc:[a-z2-7]{24}/ },
  // Key-shaped strings.
  { name: "anthropic key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: "google api key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "github token", re: /github_pat_[A-Za-z0-9_]{40,}/ },
  { name: "slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "stripe key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { name: "resend key", re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/ },
  { name: "supabase key", re: /\b(?:sbp|sb_secret|sb_publishable)_[A-Za-z0-9_-]{20,}/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KE[Y]-----/ },
  { name: "assigned secret", re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-\/+=]{24,}["']/i },
  // Bot-detection bypass.
  { name: "stealth plugin", re: /puppeteer-extr[a]-plugin-stealt[h]/i },
  { name: "stealth plugin", re: /\b(?:puppeteer|playwright)-extr[a]\b/i },
  { name: "stealth plugin", re: /StealthPlugi[n]/ },
  { name: "captcha service", re: /\b2captch[a]/i },
  { name: "captcha service", re: /anti-?captch[a]/i },
  { name: "captcha service", re: /capsolve[r]|capmonste[r]/i },
  { name: "captcha service", re: /captch[a].?solv/i },
  { name: "webdriver override", re: /defineProperty\(\s*navigator\s*,\s*["'`]webdrive[r]/ },
  { name: "webdriver override", re: /navigator\.webdrive[r]\s*=(?!=)/ },
  { name: "webdriver override", re: /AutomationControlle[d]/ },
];

/** Every fingerprinted literal found in `text`, by Rabin-Karp per length, confirmed by SHA-256. */
export function findFingerprints(text, prints = FINGERPRINTS) {
  const s = text.toLowerCase();
  const found = [];
  const byLen = new Map();
  for (const p of prints) {
    if (!byLen.has(p.len)) byLen.set(p.len, []);
    byLen.get(p.len).push(p);
  }
  for (const [len, group] of byLen) {
    if (s.length < len) continue;
    const targets = new Set(group.map((p) => p.rh));
    let pow = 1;
    for (let i = 1; i < len; i++) pow = (pow * B) % M;
    let h = 0;
    for (let i = 0; i < len; i++) h = (h * B + s.charCodeAt(i)) % M;
    for (let start = 0; ; start++) {
      if (targets.has(h)) {
        const sha = createHash("sha256").update(s.slice(start, start + len), "latin1").digest("hex").slice(0, 32);
        const hit = group.find((p) => p.rh === h && p.sha === sha);
        if (hit) found.push({ name: hit.name, index: start });
      }
      const end = start + len;
      if (end >= s.length) break;
      h = (h - ((s.charCodeAt(start) * pow) % M) + M) % M;
      h = (h * B + s.charCodeAt(end)) % M;
    }
  }
  return found;
}

/** Every finding in one file's text, with line numbers. */
export function scanText(text, prints = FINGERPRINTS) {
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const findings = findFingerprints(text, prints).map((f) => ({ pattern: f.name, line: lineOf(f.index) }));
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) findings.push({ pattern: p.name, line: lineOf(m.index) });
  }
  return findings;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next"]);

function gitFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else if (st.isFile()) out.push(relative(root, full));
  }
  return out;
}

/** Scans `root` and returns the findings, or throws when it cannot scan at all. */
export function scan(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const isRepo = existsSync(join(root, ".git"));
  const files = (isRepo ? gitFiles(root) : null) ?? walk(root);
  const present = files.filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  if (present.length === 0) throw new Error(`no files to scan under ${root}`);
  const findings = [];
  for (const rel of present) {
    const text = readFileSync(join(root, rel)).toString("latin1");
    for (const f of scanText(text)) findings.push({ file: rel, ...f });
  }
  return { files: present.length, findings };
}

function main() {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
  let result;
  try {
    result = scan(root);
  } catch (err) {
    console.error(`scrub-gate: FAILED CLOSED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (result.findings.length) {
    for (const f of result.findings) console.error(`scrub-gate: ${f.file}:${f.line}: ${f.pattern}`);
    console.error(`scrub-gate: FAILED with ${result.findings.length} finding(s) in ${result.files} files`);
    process.exitCode = 1;
    return;
  }
  console.log(`scrub-gate: clean (${result.files} files, ${FINGERPRINTS.length} fingerprints, ${PATTERNS.length} patterns)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
