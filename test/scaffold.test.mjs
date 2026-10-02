// `actionrail new-app`: each view writes its files, every TypeScript file parses, every
// placeholder is filled, and the generated app depends on this package.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { newApp } from "../dist/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

function fresh() {
  return mkdtempSync(join(tmpdir(), "actionrail-app-"));
}

function parses(file, text) {
  const out = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const SHARED = ["package.json", ".gitignore", ".env.example", "README.md", "app/globals.css", "app/icon.svg", "app/layout.tsx", "app/page.tsx", "app/api/cron/pass/route.ts", "app/api/cron/dispatch/route.ts", "app/api/queue/route.ts", "app/api/queue/[action]/route.ts", "lib/agent.ts", "lib/manifest.ts", "lib/tenant.ts", "lib/use-queue.ts"];

const EXPECT = {
  console: { has: ["components/Console.tsx"], lacks: ["components/SimpleHome.tsx", "components/site-view/Welcome.tsx"] },
  simple: { has: ["components/SimpleHome.tsx", "components/Disclosure.tsx"], lacks: ["components/Console.tsx", "components/site-view/Welcome.tsx"] },
  both: {
    has: ["components/Console.tsx", "components/SimpleHome.tsx", "components/site-view/Welcome.tsx", "components/site-view/SiteViewProvider.tsx", "components/site-view/ViewControls.tsx"],
    lacks: [],
  },
};

describe("new-app", () => {
  for (const app of ["console", "simple", "both"]) {
    it(`scaffolds --app ${app}`, () => {
      const dir = join(fresh(), "Help Desk Agent");
      const files = newApp({ dir, app });
      for (const f of [...SHARED, ...EXPECT[app].has]) assert.ok(files.includes(f), `${f} is written`);
      for (const f of EXPECT[app].lacks) assert.ok(!files.includes(f), `${f} is not written`);
      for (const f of files) {
        const text = readFileSync(join(dir, f), "utf8");
        assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), `${f} has no unfilled placeholder`);
        if (/\.tsx?$/.test(f)) assert.deepEqual(parses(f, text), [], `${f} parses`);
      }
      const appPkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert.equal(appPkg.name, "help-desk-agent");
      assert.equal(appPkg.dependencies.actionrail, `^${pkg.version}`);
      assert.ok(appPkg.dependencies.next);
      const manifest = readFileSync(join(dir, "lib/manifest.ts"), "utf8");
      assert.match(manifest, /app: "help-desk-agent"/);
      assert.match(manifest, /events: "help_desk_agent_events"/);
      const page = readFileSync(join(dir, "app/page.tsx"), "utf8");
      if (app === "both") assert.match(page, /PageViews/);
      const layout = readFileSync(join(dir, "app/layout.tsx"), "utf8");
      if (app === "both") assert.match(layout, /SiteViewProvider/);
      else assert.doesNotMatch(layout, /SiteViewProvider/);
    });
  }

  it("refuses a directory that is not empty", () => {
    const dir = fresh();
    writeFileSync(join(dir, "keep.txt"), "x");
    assert.throws(() => newApp({ dir, app: "console" }), /not empty/);
  });

  it("refuses an unknown view", () => {
    assert.throws(() => newApp({ dir: join(fresh(), "x"), app: "fancy" }), /console, simple or both/);
  });

  it("runs from the command line", () => {
    const parent = fresh();
    const ok = spawnSync(process.execPath, [CLI, "new-app", join(parent, "desk"), "--app", "both", "--name", "Desk"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /npm run dev/);
    const missing = spawnSync(process.execPath, [CLI, "new-app", join(parent, "x")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.equal(execFileSync(process.execPath, [CLI, "version"], { encoding: "utf8" }).trim(), pkg.version);
    mkdirSync(join(parent, "busy"));
    writeFileSync(join(parent, "busy", "f"), "x");
    const busy = spawnSync(process.execPath, [CLI, "new-app", join(parent, "busy"), "--app", "simple"], { encoding: "utf8" });
    assert.equal(busy.status, 1);
  });
});
