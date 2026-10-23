/**
 * Fails when a file in `src/` or `scripts/` scores worse on fta (Fast TypeScript Analyzer) than
 * the threshold, or than its baseline in `fta-baseline.json`. A baseline that improved or is no
 * longer needed fails too, so `--update` keeps baselines falling. Only `--init`, run once at
 * adoption, adds baselines; raising or adding one later needs the maintainer's approval.
 *
 * Run from the repo root with `pnpm fta`, or `pnpm fta:update` to lower the baselines.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runFta } from "fta-cli";

export type Mode = "check" | "update" | "init";
export type Outcome = { failures: string[]; stale: string[]; next: Map<string, number> };

const sourceDirs = ["src", "scripts"];
// fta calls a score above 60 "needs improvement". At adoption (2026-10-22) only five test files
// scored above it, so they hold baselines and every other file stays within it.
export const threshold = 60;
const baselineFile = "fta-baseline.json";

function isScored(value: unknown): value is { file_name: string; fta_score: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "file_name" in value &&
    typeof value.file_name === "string" &&
    "fta_score" in value &&
    typeof value.fta_score === "number"
  );
}

export function parseScores(dir: string, json: string): [string, number][] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new TypeError(`fta returned no file list for ${dir}`);
  return parsed.map((file: unknown): [string, number] => {
    if (!isScored(file))
      throw new TypeError(`fta returned an entry without a score: ${JSON.stringify(file)}`);
    return [`${dir}/${file.file_name}`, Math.round(file.fta_score * 100) / 100];
  });
}

export function parseBaselines(json: string): Map<string, number> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${baselineFile} must hold an object`);
  }
  return new Map(
    Object.entries(parsed).map(([file, score]) => {
      if (typeof score !== "number") throw new TypeError(`${file}'s baseline is not a number`);
      return [file, score];
    }),
  );
}

function compare(file: string, score: number, baseline: number, outcome: Outcome): void {
  if (score > baseline) {
    outcome.failures.push(`${file} scores ${score}, worse than its baseline ${baseline}.`);
    outcome.next.set(file, baseline);
  } else if (score > threshold) {
    outcome.next.set(file, score);
    if (score < baseline) outcome.stale.push(`${file} improved from ${baseline} to ${score}.`);
  } else {
    outcome.stale.push(`${file} scores ${score}, within ${threshold}, so it needs no baseline.`);
  }
}

function judgeNew(file: string, score: number, mode: Mode, outcome: Outcome): void {
  if (score <= threshold) return;
  if (mode === "init") {
    outcome.next.set(file, score);
    outcome.stale.push(`${file} recorded at ${score}.`);
  } else {
    outcome.failures.push(
      `${file} scores ${score}. A file without a baseline must score ${threshold} or less.`,
    );
  }
}

export function judge(
  scores: ReadonlyMap<string, number>,
  baselines: ReadonlyMap<string, number>,
  mode: Mode,
): Outcome {
  const outcome: Outcome = { failures: [], stale: [], next: new Map() };
  for (const [file, score] of scores) {
    const baseline = baselines.get(file);
    if (baseline === undefined) judgeNew(file, score, mode, outcome);
    else compare(file, score, baseline, outcome);
  }
  for (const file of baselines.keys()) {
    if (!scores.has(file)) outcome.stale.push(`${file} has a baseline but no longer exists.`);
  }
  return outcome;
}

function modeOf(args: readonly string[]): Mode {
  const [arg, ...rest] = args;
  if (rest.length > 0) throw new Error(`Expected at most one flag, got ${args.join(" ")}.`);
  if (arg === undefined) return "check";
  if (arg === "--init") return "init";
  if (arg === "--update") return "update";
  throw new Error(`Unknown flag "${arg}"; expected --init or --update.`);
}

const scoreDir = (dir: string): [string, number][] => parseScores(dir, runFta(dir, { json: true }));

function loadBaselines(mode: Mode, baselinePath: string): Map<string, number> {
  if (mode !== "init") return parseBaselines(readFileSync(baselinePath, "utf8"));
  if (existsSync(baselinePath)) {
    throw new Error(`${baselinePath} exists; --init runs once, at adoption.`);
  }
  return new Map();
}

function settle(mode: Mode, { failures, stale, next }: Outcome, baselinePath: string): string[] {
  if (mode === "check") {
    if (stale.length === 0) return failures;
    return [...failures, ...stale, `Run \`pnpm fta:update\` and commit ${baselinePath}.`];
  }
  const sorted = Object.fromEntries([...next].toSorted(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  for (const line of stale) console.log(`Updated: ${line}`);
  return failures;
}

export function main(
  args: readonly string[] = process.argv.slice(2),
  score: (dir: string) => [string, number][] = scoreDir,
  baselinePath: string = baselineFile,
): void {
  const mode = modeOf(args);
  const baselines = loadBaselines(mode, baselinePath);
  const scores = new Map(sourceDirs.flatMap((dir) => score(dir)));
  const failures = settle(mode, judge(scores, baselines, mode), baselinePath);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`fta: ${scores.size} files within their limits.`);
  }
}

if (import.meta.main) main();
