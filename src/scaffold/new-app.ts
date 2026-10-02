// `actionrail new-app`: scaffolds a Next.js app wired to the runner.
//
//   --app console  the dense working surface: queue, ledger and caps on one screen
//   --app simple   the roomier view: one draft at a time, details behind disclosures
//   --app both     both views, a welcome dialog that explains the agent, and a footer switch
//
// The views follow the Console and Simple shells Compound Labs uses on its own products. The
// templates live in src/scaffold/templates and are copied with three placeholders filled in.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppKind = "console" | "simple" | "both";

export interface NewAppOptions {
  /** Where to write the app. It must not exist or must be empty. */
  dir: string;
  app: AppKind;
  /** The display name. Defaults to the directory name. */
  name?: string;
  /** The dependency spec for actionrail in the new package.json. Defaults to this version. */
  actionrailSpec?: string;
}

const LAYERS: Record<AppKind, string[]> = {
  console: ["common", "console"],
  simple: ["common", "simple"],
  both: ["common", "console", "simple", "both"],
};

const RENAMES: Record<string, string> = { gitignore: ".gitignore", "env.example": ".env.example" };

function packageRoot(): string {
  // dist/scaffold/new-app.js and src/scaffold/new-app.ts both sit two levels under the root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function templatesDir(): string {
  return join(packageRoot(), "src", "scaffold", "templates");
}

function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent-app"
  );
}

/** Writes the app and returns the relative paths it wrote, sorted. */
export function newApp(opts: NewAppOptions): string[] {
  if (!LAYERS[opts.app]) throw new Error(`--app must be console, simple or both, not "${String(opts.app)}"`);
  const target = resolve(opts.dir);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} is not empty`);
  const rawName = opts.name ?? target.split(/[\\/]/).filter(Boolean).at(-1) ?? "Agent app";
  const name = rawName.replace(/[<>"'`{}$\\]/g, "").trim() || "Agent app";
  const slug = slugify(name);
  const tablePrefix = (/^[a-z_]/.test(slug) ? slug : `app_${slug}`).replace(/-/g, "_").slice(0, 40);
  const spec = opts.actionrailSpec ?? `^${ownVersion()}`;
  const fill = (s: string) =>
    s
      .replaceAll("{{APP_NAME}}", name)
      .replaceAll("{{APP_SLUG_UNDERSCORE}}", tablePrefix)
      .replaceAll("{{APP_SLUG}}", slug).replaceAll("{{ACTIONRAIL_SPEC}}", spec).replaceAll("{{VIEW}}", opts.app);

  const files = new Map<string, string>();
  for (const layer of LAYERS[opts.app]) {
    const root = join(templatesDir(), layer);
    for (const file of walk(root)) {
      let rel = relative(root, file).replace(/\\/g, "/").replace(/\.tmpl$/, "");
      const base = rel.split("/").at(-1) as string;
      if (RENAMES[base]) rel = rel.slice(0, rel.length - base.length) + RENAMES[base];
      files.set(rel, fill(readFileSync(file, "utf8")));
    }
  }
  for (const [rel, body] of files) {
    const out = join(target, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
  }
  return [...files.keys()].sort();
}
