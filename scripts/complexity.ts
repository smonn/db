/**
 * Lists every function in `src/` and `scripts/` whose cyclomatic complexity is above a cap, worst
 * first, one line each: `score function file:line`. It exits 0 whether or not any function is
 * listed; the cap enforced in CI lives in the oxlint config, this only reports.
 *
 * Run from the repo root with `node scripts/complexity.ts [max]` (default 6, the #248 target).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Finding = { score: number; name: string; file: string; line: number };
export type Run = (configPath: string) => { status: number | null; stdout: string };

export const defaultMax = 6;
const paths = ["src", "scripts"];
const diagnostic =
  /^(.+?):(\d+):\d+: (?:[a-z]+ )*(?:function|method)(?: `([^`]+)`)? has a complexity of (\d+)\./u;

export function parseDiagnostics(output: string): Finding[] {
  const findings: Finding[] = [];
  for (const text of output.split("\n")) {
    const match = diagnostic.exec(text);
    if (match === null) continue;
    const [, file = "", line = "", name, score = ""] = match;
    findings.push({ score: Number(score), name: name ?? "<anonymous>", file, line: Number(line) });
  }
  return findings;
}

export function format(findings: readonly Finding[]): string[] {
  return findings
    .toSorted((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
    .map(({ score, name, file, line }) => `${score} ${name} ${file}:${line}`);
}

export function parseMax(args: readonly string[]): number {
  const [arg, ...rest] = args;
  if (rest.length > 0) throw new Error(`Expected at most one argument, got ${args.join(" ")}.`);
  if (arg === undefined) return defaultMax;
  if (!/^\d+$/u.test(arg)) throw new Error(`Expected a whole number for max, got "${arg}".`);
  return Number(arg);
}

const runOxlint: Run = (configPath) => {
  const result = spawnSync("pnpm", ["exec", "oxlint", "-c", configPath, "-f", "unix", ...paths], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
};

export function main(args: readonly string[] = process.argv.slice(2), run: Run = runOxlint): void {
  const max = parseMax(args);
  const dir = mkdtempSync(join(tmpdir(), "complexity-"));
  try {
    const configPath = join(dir, "oxlint.json");
    writeFileSync(configPath, JSON.stringify({ rules: { complexity: ["error", { max }] } }));
    const { status, stdout } = run(configPath);
    // oxlint exits 1 for lint errors and for a broken config alike; only a problem count says which.
    if (status !== 0 && !/^\d+ problems?$/mu.test(stdout)) {
      throw new Error(`oxlint failed (exit ${String(status)}):\n${stdout}`);
    }
    for (const line of format(parseDiagnostics(stdout))) console.log(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
