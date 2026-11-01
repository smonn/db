/**
 * Checks the `Stryker disable` comments of some files without a throwaway checkout: it swaps each
 * comment in the named files for the inert marker (`mark-stryker-disables.ts`), runs Stryker on
 * those files, prints each disable with the survivors it states and the survivors its mutators
 * have on its line, and puts the files back as they were, also when Stryker fails or the process
 * gets SIGINT or SIGTERM.
 *
 * Run with `pnpm mutation:disables --mutate a.ts,b.ts`. A file with no disable is left out of the
 * run, since Stryker would mutate it for nothing.
 */
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { onProcessInterrupt } from "../src/dev/cli/signals.ts";
import type { OnInterrupt } from "../src/dev/shadow/index.ts";
import { array, field, parseJson, record, string } from "./github-json.ts";
import {
  hides,
  type Mutant,
  readMutant,
  REPORT,
  survivorCount,
  timedOut,
} from "./mutation-report.ts";
import { type Disable, markDisables, markedDisables } from "./stryker-directive.ts";

const USAGE = "Usage: pnpm mutation:disables --mutate a.ts,b.ts";

export type RunStryker = (files: string[], signal: AbortSignal) => Promise<void>;

/** Runs Stryker on `files` without blocking, so a signal handler can run and `signal` can stop it. */
function runStryker(root: string, files: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile(
      join(root, "node_modules", ".bin", "stryker"),
      ["run", "--mutate", files.join(",")],
      { cwd: root, encoding: "utf8", signal },
      (error, stdout, stderr) => {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        if (error === null) resolveRun();
        else reject(new Error(`Stryker failed in ${root}`, { cause: error }));
      },
    );
  });
}

function verdict(disable: Disable, hidden: Mutant[]): string {
  const found = survivorCount(hidden);
  if (hidden.length === 0) return "no mutant on the next line, so the disable hides nothing";
  if (found > disable.expected) return "more survivors than stated: the weekly run lists them all";
  if (found + timedOut(hidden) < disable.expected) return "fewer survivors than stated: stale";
  return "matches";
}

function describe(file: string, disable: Disable, mutants: Mutant[]): string {
  const hidden = mutants.filter((mutant) => hides(disable, mutant));
  const perMutator = disable.mutators.map((mutator) => {
    const mine = hidden.filter((mutant) => hides({ ...disable, mutators: [mutator] }, mutant));
    return `${mutator} ${survivorCount(mine)}`;
  });
  const states = `states ${disable.expected}`;
  const found = `survivors ${survivorCount(hidden)} (${perMutator.join(", ")})`;
  return `${file}:${disable.line} ${states}, ${found}: ${verdict(disable, hidden)}`;
}

/** One line per marked disable of the files in a Stryker JSON report, by file then line. */
export function describeDisables(report: unknown): string[] {
  const files = field(record(report, "$"), "files", record, "$");
  return Object.entries(files)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, entry]) => {
      const path = `$.files[${JSON.stringify(file)}]`;
      const fileReport = record(entry, path);
      const mutants = field(fileReport, "mutants", array(readMutant), path);
      const source = field(fileReport, "source", string, path);
      return markedDisables(source).map((disable) => describe(file, disable, mutants));
    });
}

/** The source of each file in `files` (relative to `cwd`) that holds a `Stryker disable` comment. */
function sourcesWithDisables(files: string[], cwd: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    if (markDisables(source) !== source) sources.set(file, source);
  }
  return sources;
}

/**
 * Marks the disables in `files` (relative to `cwd`), runs `run` on those that hold one, prints
 * the outcome of each disable, and restores every file it rewrote.
 */
export async function checkDisables(
  files: string[],
  cwd: string,
  run: RunStryker = (selected, signal) => runStryker(cwd, selected, signal),
  onInterrupt: OnInterrupt = onProcessInterrupt(),
): Promise<void> {
  const sources = sourcesWithDisables(files, cwd);
  if (sources.size === 0) {
    console.log(`No Stryker disable comments in ${files.join(", ")}`);
    return;
  }
  const stop = new AbortController();
  let restored = false;
  // Runs on a signal and again once the run unwinds; the second run finds nothing left to do.
  const restore = (): Promise<void> => {
    if (!restored) {
      restored = true;
      stop.abort();
      for (const [file, source] of sources) writeFileSync(resolve(cwd, file), source);
    }
    return Promise.resolve();
  };
  const unregister = onInterrupt(restore);
  try {
    const reportPath = join(cwd, REPORT);
    rmSync(reportPath, { force: true });
    for (const [file, source] of sources) writeFileSync(resolve(cwd, file), markDisables(source));
    await run([...sources.keys()], stop.signal);
    const report = parseJson(readFileSync(reportPath, "utf8"), reportPath);
    for (const line of describeDisables(report)) console.log(line);
  } finally {
    unregister();
    await restore();
  }
}

/** The files `--mutate a.ts,b.ts` names, or undefined when `args` is not exactly that. */
export function parseArgs(args: readonly string[]): string[] | undefined {
  const [flag, selection, ...rest] = args;
  if (flag !== "--mutate" || selection === undefined || rest.length > 0) return undefined;
  const files = selection.split(",");
  return files.some((file) => file === "" || file.startsWith("-")) ? undefined : files;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<void> {
  const files = parseArgs(args);
  if (files === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    await checkDisables(files, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
