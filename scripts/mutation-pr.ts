/**
 * Runs Stryker on the mutable files a pull request changes and writes the survivors to the job
 * summary, the ones on lines the PR changed first, then the run time (#801). It never fails on a
 * survivor: the weekly Mutation run (`mutation.yml`) stays the gate-less record, and this run only
 * measures how long a per-PR run takes and how noisy it is. It fails when Stryker itself does.
 *
 * Run as `pnpm mutation:pr` after `pnpm mutation:mark`, in the checkout of a pull request's merge
 * commit: it diffs `PR_DIFF_BASE` (default `HEAD^1`, the base) against `HEAD`. It writes to the file
 * `GITHUB_STEP_SUMMARY` names, or to stdout when that is unset.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { parseJson } from "./github-json.ts";
import { mutatedFiles } from "./mark-stryker-disables.ts";
import { mutateGlobs } from "./mutation-shards.ts";
import {
  findings,
  REPORT,
  staleSection,
  survivorRow,
  type StaleDisable,
  type Survivor,
} from "./mutation-report.ts";

const MAX_ROWS = 100;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;
const NEW_FILE = /^\+\+\+ b\/(.+)/u;

/** The changed files that Stryker mutates, sorted. */
export const mutableChanges = (changed: string[], mutable: string[]): string[] => {
  const set = new Set(mutable);
  return changed.filter((file) => set.has(file)).toSorted();
};

function hunkLines(text: string): number[] {
  const hunk = HUNK.exec(text);
  if (hunk === null) return [];
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/** The lines each file gains or changes, from the hunks of a zero-context unified diff. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  // Hunks before the first file header land in a set nobody reads.
  let current = new Set<number>();
  for (const text of diff.split("\n")) {
    const file = NEW_FILE.exec(text)?.[1];
    if (file === undefined) {
      for (const line of hunkLines(text)) current.add(line);
      continue;
    }
    current = new Set();
    result.set(file, current);
  }
  return result;
}

export function splitSurvivors(
  survivors: Survivor[],
  lines: Map<string, Set<number>>,
): { onChanged: Survivor[]; others: Survivor[] } {
  const onChanged = (survivor: Survivor): boolean =>
    lines.get(survivor.file)?.has(survivor.line) === true;
  return {
    onChanged: survivors.filter((survivor) => onChanged(survivor)),
    others: survivors.filter((survivor) => !onChanged(survivor)),
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function survivorTable(heading: string, list: Survivor[]): string[] {
  if (list.length === 0) return [];
  const rows = list.slice(0, MAX_ROWS).map((survivor) => survivorRow(survivor));
  const hidden = list.length - rows.length;
  return [
    "",
    `### ${heading} (${list.length})`,
    "",
    "| File | Line | Mutator | Status |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(hidden > 0 ? ["", `${hidden} more not shown.`] : []),
  ];
}

export function header(files: string[]): string {
  const noun = files.length === 1 ? "file" : "files";
  const list = files.map((file) => `\`${file}\``).join(", ");
  return `## Mutation on changed files\n\nMutated ${files.length} ${noun}: ${list}\n`;
}

export type SummaryInput = {
  onChanged: Survivor[];
  others: Survivor[];
  stale: StaleDisable[];
  ms: number;
};

export function summary({ onChanged, others, stale, ms }: SummaryInput): string {
  const none = onChanged.length === 0 && others.length === 0 && stale.length === 0;
  return [
    ...survivorTable("Survivors on lines this PR changed", onChanged),
    ...survivorTable("Other survivors in the changed files", others),
    ...staleSection(stale),
    ...(none ? ["", "No mutant survives."] : []),
    "",
    `Run time: ${formatDuration(ms)}`,
    "",
  ].join("\n");
}

export type Deps = {
  git: (args: string[]) => string;
  mutable: () => string[];
  stryker: (files: string[]) => void;
  report: () => unknown;
  now: () => number;
  write: (text: string) => void;
};

export function realDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const { GITHUB_STEP_SUMMARY: summaryPath } = env;
  return {
    git: (args) => execFileSync("git", args, { encoding: "utf8" }),
    mutable: () => mutatedFiles(mutateGlobs({}), process.cwd()),
    stryker: (files) => {
      execFileSync("node_modules/.bin/stryker", ["run", "--mutate", files.join(",")], {
        stdio: "inherit",
      });
    },
    report: () => parseJson(readFileSync(REPORT, "utf8"), REPORT),
    now: () => Date.now(),
    write: (text) => {
      if (summaryPath === undefined || summaryPath === "") process.stdout.write(text);
      else appendFileSync(summaryPath, text);
    },
  };
}

export function main(env: NodeJS.ProcessEnv = process.env, deps: Deps = realDeps(env)): void {
  const { PR_DIFF_BASE: base = "HEAD^1" } = env;
  const names = deps.git(["diff", "--name-only", "--diff-filter=d", base, "HEAD"]);
  const files = mutableChanges(names.split("\n"), deps.mutable());
  if (files.length === 0) {
    deps.write("No mutable files changed.\n");
    return;
  }
  // Written first, so a run the job timeout kills still names what it was mutating.
  deps.write(header(files));
  const start = deps.now();
  try {
    deps.stryker(files);
  } catch (error) {
    deps.write(`\nStryker failed after ${formatDuration(deps.now() - start)}.\n`);
    throw error;
  }
  const ms = deps.now() - start;
  const lines = changedLines(deps.git(["diff", "--unified=0", "--no-color", base, "HEAD"]));
  const { survivors, stale } = findings(deps.report());
  deps.write(summary({ ...splitSurvivors(survivors, lines), stale, ms }));
}

if (import.meta.main) main();
