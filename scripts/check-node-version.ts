/**
 * Checks that the Node version agrees across `.tool-versions` (asdf), `devEngines.runtime` in
 * package.json, and the `node@runtime` entries in pnpm-lock.yaml. The lockfile importer must hold
 * `specifier: runtime:<devEngines range>` and `version: runtime:<asdf version>`. A frozen-lockfile
 * install already fails when the specifier drifts from package.json. The check compares strings and
 * does no semver: if `.tool-versions` and the lockfile are bumped together to a version outside
 * `devEngines.runtime` (25.0.0 against `^24.22.1`), it passes, because a frozen install checks
 * specifiers, not whether the resolved version satisfies them. Accepted to avoid a semver dependency.
 * Prints each problem and exits 1.
 *
 * Run from the repo root with `pnpm check:node-version`; CI runs it in the Lint job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "./github-json.ts";

export type NodeVersionSources = {
  toolVersions: string;
  packageJson: string;
  lockfile: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function nodeRange(pkg: unknown): string | undefined {
  const runtime = isRecord(pkg) && isRecord(pkg["devEngines"]) ? pkg["devEngines"]["runtime"] : [];
  for (const entry of [runtime].flat())
    if (isRecord(entry) && entry["name"] === "node" && typeof entry["version"] === "string")
      return entry["version"];
  return undefined;
}

function importerProblems(importer: RegExpExecArray, range: string, asdf: string): string[] {
  const problems: string[] = [];
  if (importer[1] !== `runtime:${range}`)
    problems.push(
      `pnpm-lock.yaml node specifier is ${importer[1]}, expected runtime:${range} (devEngines.runtime)`,
    );
  if (importer[2] !== `runtime:${asdf}`)
    problems.push(
      `pnpm-lock.yaml node version is ${importer[2]}, expected runtime:${asdf} (.tool-versions)`,
    );
  return problems;
}

function runtimeKeyProblems(lockfile: string, asdf: string): string[] {
  const keys = [...lockfile.matchAll(/^ {2}node@runtime:(\S+?):/gmu)].map((m) => m[1]);
  const problems: string[] = [];
  if (keys.length === 0) problems.push("pnpm-lock.yaml has no node@runtime package entry");
  for (const key of new Set(keys))
    if (key !== asdf)
      problems.push(`pnpm-lock.yaml has node@runtime:${key}, expected ${asdf} (.tool-versions)`);
  return problems;
}

export function checkNodeVersion(sources: NodeVersionSources): string[] {
  const asdf = /^nodejs[ \t]+(\S+)[ \t]*$/mu.exec(sources.toolVersions)?.[1];
  if (asdf === undefined) return [".tool-versions has no nodejs entry"];

  const range = nodeRange(parseJson(sources.packageJson, "package.json"));
  if (range === undefined) return ["package.json devEngines.runtime has no node version"];

  const importer = /^ {6}node:\n {8}specifier: (\S+)\n {8}version: (\S+)$/mu.exec(sources.lockfile);
  if (importer === null) return ["pnpm-lock.yaml has no node runtime importer entry"];

  return [
    ...importerProblems(importer, range, asdf),
    ...runtimeKeyProblems(sources.lockfile, asdf),
  ];
}

export function main(cwd = "."): void {
  const read = (file: string): string => readFileSync(join(cwd, file), "utf8");
  const problems = checkNodeVersion({
    toolVersions: read(".tool-versions"),
    packageJson: read("package.json"),
    lockfile: read("pnpm-lock.yaml"),
  });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
