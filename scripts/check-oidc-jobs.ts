/**
 * Checks that a workflow job holding `id-token: write` runs no dependency code. npm trusted
 * publishing trades that token for a publish token, so an install script, a build, a step `env:` or
 * `shell:`, or a value taken from another job's outputs could publish under the package's name.
 *
 * Refuses by default: a job that grants id-token must match `publishJob` below line for line, after
 * dropping comments and blank lines. It pins exact action SHAs, since a SHA from a fork resolves
 * under the parent repo's name. The pnpm version it pins must equal the one pnpm-lock.yaml resolves
 * for `devEngines.packageManager`, which holds a range. A grant outside a job, `write-all`, and
 * workflow-level `env` or `defaults` are refused too. The grant is matched loosely (any quoting,
 * indent, trailing comment, or flow map), so a job that hides one still meets the template. Reads
 * lines rather than parsing YAML, to avoid a YAML dependency, so it first refuses, in every workflow,
 * the YAML forms that scripts/workflow-yaml.ts can't read line by line. Prints each problem and
 * exits 1.
 *
 * Changing the Publish job means changing `publishJob` in the same PR. A Renovate customManagers
 * entry bumps its SHAs with the workflow's, keyed on the `// vX.Y.Z` comment above each. Run from the repo
 * root with `pnpm check:oidc`; CI runs it in the Lint job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowYamlProblems } from "./workflow-yaml.ts";

const publishJob = (pnpm: string): string[] => [
  "publish:",
  "  name: Publish",
  "  needs: pack",
  "  runs-on: ubuntu-24.04",
  "  permissions:",
  "    id-token: write",
  "  steps:",
  // v8.0.2
  "    - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  "      with:",
  "        name: package",
  "        path: ${{ runner.temp }}/pkg",
  // v3.1.2
  "    - uses: pnpm/setup@fa36a5ef7dcdefc3a7cb25655c122e00cf6e636e",
  "      with:",
  `        version: ${pnpm}`,
  "        install: false",
  "    - run: |",
  '        test -f "$RUNNER_TEMP/pkg/package.tgz"',
  '        test ! -L "$RUNNER_TEMP/pkg/package.tgz"',
  "        empty=$(mktemp -d)",
  '        cd "$empty"',
  '        pnpm stage publish --ignore-scripts --no-git-checks "$RUNNER_TEMP/pkg/package.tgz"',
];

/** The SHA `publishJob` pins for an action, so test fixtures follow Renovate's bumps. */
export function pinnedSha(action: string): string {
  const prefix = `    - uses: ${action}@`;
  const line = publishJob("").find((text) => text.startsWith(prefix));
  if (line === undefined) throw new Error(`publishJob pins no ${action}.`);
  return line.slice(prefix.length);
}

const grantsIdToken = /id-token["']?\s*:\s*["']?write\b/u;
const grantsAll = /:\s*["']?write-all\b/u;
const workflowSetting = /^["']?(env|defaults)["']?\s*:/u;

type Line = { text: string; indent: number };
type Job = { name: string; indent: number; lines: Line[] };

const indentOf = (text: string): number => text.length - text.trimStart().length;

function readLines(workflow: string): Line[] {
  return workflow
    .split("\n")
    .filter((text) => text.trim() !== "" && !text.trimStart().startsWith("#"))
    .map((text) => ({ text, indent: indentOf(text) }));
}

function groupJobs(lines: Line[], jobIndent: number): Job[] {
  const starts = lines.flatMap((line, index) =>
    line.indent <= jobIndent ? [{ line, index }] : [],
  );
  return starts.map(({ line, index }, position) => ({
    name: line.text.trim().replace(/:.*/u, ""),
    indent: line.indent,
    lines: lines.slice(index, starts[position + 1]?.index),
  }));
}

function splitJobs(lines: Line[]): { header: Line[]; jobs: Job[] } {
  const start = lines.findIndex((line) => line.text.startsWith("jobs:"));
  if (start === -1) return { header: lines, jobs: [] };
  const jobIndent = lines[start + 1]?.indent ?? 0;
  const next = lines.findIndex((line, index) => index > start && line.indent === 0);
  const end = next === -1 ? lines.length : next;
  return {
    header: [...lines.slice(0, start), ...lines.slice(end)],
    jobs: groupJobs(lines.slice(start + 1, end), jobIndent),
  };
}

// Each template line ends outside any quote, so a line cut at a `#` inside quotes still differs
// from it, and a ` #` after a whole line is a comment to YAML and to the run script's bash alike.
function normalize(job: Job): string[] {
  return job.lines.map((line) => line.text.slice(job.indent).replace(/\s#.*/u, "").trimEnd());
}

function checkJob(job: Job, file: string, pnpm: string): string[] {
  const actual = normalize(job);
  const expected = publishJob(pnpm);
  const at = actual.findIndex((line, index) => line !== expected[index]);
  const index = at === -1 && actual.length !== expected.length ? actual.length : at;
  if (index === -1) return [];
  const found = actual[index] ?? "the end of the job";
  return [
    `${file} job ${job.name} holds id-token but differs from publishJob in scripts/check-oidc-jobs.ts at its line ${index + 1}: expected "${expected[index] ?? "the end of the job"}", found "${found}"`,
  ];
}

function headerProblems(header: Line[], file: string): string[] {
  const problems: string[] = [];
  if (header.some((line) => grantsIdToken.test(line.text)))
    problems.push(`${file} grants id-token outside a job; grant it to the publish job only`);
  for (const line of header) {
    const setting = workflowSetting.exec(line.text)?.[1];
    if (setting !== undefined)
      problems.push(
        `${file} sets workflow-level ${setting}, which reaches the job holding id-token`,
      );
  }
  return problems;
}

export function checkOidcJobs(workflow: string, file: string, pnpm: string): string[] {
  const unreadable = workflowYamlProblems(workflow, file);
  if (unreadable.length > 0) return unreadable;
  const lines = readLines(workflow);
  const { header, jobs } = splitJobs(lines);
  const problems: string[] = [];
  if (lines.some((line) => grantsAll.test(line.text)))
    problems.push(`${file} grants write-all, which includes id-token; grant id-token alone`);
  if (!lines.some((line) => grantsIdToken.test(line.text))) return problems;
  problems.push(...headerProblems(header, file));
  for (const job of jobs)
    if (job.lines.some((line) => grantsIdToken.test(line.text)))
      problems.push(...checkJob(job, file, pnpm));
  return problems;
}

export function lockedPnpm(lockfile: string): string | undefined {
  return /^ {4}packageManagerDependencies:\n {6}pnpm:\n {8}specifier: \S+\n {8}version: (\S+)$/mu.exec(
    lockfile,
  )?.[1];
}

export function main(cwd: string = process.cwd()): void {
  const pnpm = lockedPnpm(readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8"));
  const dir = join(cwd, ".github", "workflows");
  const problems =
    pnpm === undefined
      ? ["pnpm-lock.yaml has no packageManagerDependencies entry for pnpm"]
      : readdirSync(dir)
          .filter((file) => /\.ya?ml$/u.test(file))
          .toSorted()
          .flatMap((file) => checkOidcJobs(readFileSync(join(dir, file), "utf8"), file, pnpm));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
