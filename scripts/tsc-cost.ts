/**
 * Measures what `tsc` costs on the working tree against a base ref, for type-level design
 * decisions: it checks the base out into a temporary worktree, runs `tsc --noEmit
 * --extendedDiagnostics` three times on the base and on the working tree, interleaved, and prints
 * the median types, instantiations, and check time of each with the percent change.
 *
 * Run with `node scripts/tsc-cost.ts [base-ref]`; the base defaults to `origin/main`. The base
 * worktree links the working tree's `node_modules`, and is removed afterwards, also when tsc fails.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTable, medianSample, parseDiagnostics, type Sample } from "./tsc-cost-stats.ts";

const RUNS = 3;
const DEFAULT_BASE = "origin/main";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** What a failed `execFileSync` printed; a command that never started printed nothing. */
function stdoutOf(error: unknown): string {
  // Stryker disable next-line ConditionalExpression, LogicalOperator: 2 survivors: the `typeof` check below already rejects a missing stdout, so the guard only narrows the type.
  const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
  return typeof stdout === "string" ? stdout : "";
}

function runTsc(root: string, cwd: string): string {
  try {
    return execFileSync(
      join(root, "node_modules", ".bin", "tsc"),
      ["--noEmit", "--extendedDiagnostics"],
      { cwd, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(`tsc failed in ${cwd}:\n${stdoutOf(error)}`, { cause: error });
  }
}

function resolveBase(root: string, ref: string): string {
  if (ref.startsWith("-")) throw new Error(`Base ref "${ref}" must not start with "-"`);
  try {
    return git(root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch (error) {
    throw new Error(`Base ref "${ref}" is not a commit`, { cause: error });
  }
}

/** Alternates the trees, so a drift in machine load hits both alike. */
function sampleInterleaved(root: string, baseTree: string): { base: Sample[]; head: Sample[] } {
  const base: Sample[] = [];
  const head: Sample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    base.push(parseDiagnostics(runTsc(root, baseTree)));
    head.push(parseDiagnostics(runTsc(root, root)));
  }
  return { base, head };
}

export function measure(root: string, ref: string): string {
  const commit = resolveBase(root, ref);
  const scratch = mkdtempSync(join(tmpdir(), "tsc-cost-"));
  const baseTree = join(scratch, "base");
  let added = false;
  try {
    git(root, "worktree", "add", "--quiet", "--detach", baseTree, commit);
    added = true;
    symlinkSync(join(root, "node_modules"), join(baseTree, "node_modules"), "dir");
    const { base, head } = sampleInterleaved(root, baseTree);
    return formatTable(medianSample(base), medianSample(head));
  } finally {
    try {
      if (added) git(root, "worktree", "remove", "--force", baseTree);
    } finally {
      rmSync(scratch, { recursive: true });
    }
  }
}

function report(args: readonly string[], cwd: string): string {
  if (args.length > 1) throw new Error("Usage: node scripts/tsc-cost.ts [base-ref]");
  return measure(git(cwd, "rev-parse", "--show-toplevel"), args[0] ?? DEFAULT_BASE);
}

export function main(
  args: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): void {
  try {
    console.log(report(args, cwd));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
