#!/usr/bin/env node
// The actionrail command.
//
//   actionrail new-app <dir> --app console|simple|both [--name "Display name"]
//   actionrail version
//   actionrail help

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newApp, type AppKind } from "./scaffold/new-app.js";

const HELP = `actionrail: an agent runner with caps, an approval step, an undo window and a receipt before every send.

Usage:
  actionrail new-app <dir> --app console|simple|both [--name "Display name"] [--actionrail <dependency spec>]
  actionrail version
  actionrail help

new-app scaffolds a Next.js app wired to the runner:
  --app console   the queue, the ledger and the caps on one dense screen
  --app simple    one draft at a time, with details you open as you go
  --app both      both views, a welcome dialog and a switch in the footer
`;

function version(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (cmd === "new-app") {
    const valueFlags = new Set(["--app", "--name", "--actionrail"]);
    const positional = rest.filter((a, i) => !a.startsWith("--") && !valueFlags.has(rest[i - 1] ?? ""));
    const dir = positional[0];
    const app = flag(rest, "app") as AppKind | undefined;
    if (!dir || !app) {
      process.stderr.write("new-app needs a directory and --app console|simple|both\n\n" + HELP);
      return 2;
    }
    try {
      const files = newApp({ dir, app, name: flag(rest, "name"), actionrailSpec: flag(rest, "actionrail") });
      process.stdout.write(`Wrote ${files.length} files to ${dir}:\n${files.map((f) => `  ${f}`).join("\n")}\n\nNext:\n  cd ${dir}\n  npm install\n  npm run dev\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
