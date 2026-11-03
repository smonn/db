/**
 * Keeps repo tooling out of the release notes. release-please writes a line for each `feat`, `fix`,
 * and `perf` title (ADR-0018), and can't filter by scope, so the title has to be right (#762). A
 * release note needs a change to a shipped file, and the `tooling` scope can't add a note or change
 * shipped code. `package.json` is shipped but holds repo scripts too, so `tooling` may edit it.
 */
import { execFileSync } from "node:child_process";

const titlePattern = /^([a-z]+)(?:\(([a-z0-9-]+)\))?!?: /u;
const noteTypes: ReadonlySet<string> = new Set(["feat", "fix", "perf"]);
const shippedConfig: ReadonlySet<string> = new Set(["package.json", "tsdown.config.ts"]);

function isShippedCode(file: string): boolean {
  return file.startsWith("src/") && !/\.test(?:-helper)?\.ts$/u.test(file);
}

function parseTitle(title: string): { addsNote: boolean; tooling: boolean } {
  const [, type = "", scope] = titlePattern.exec(title) ?? [];
  return { addsNote: noteTypes.has(type), tooling: scope === "tooling" };
}

export function wantsChangedFiles(title: string): boolean {
  const { addsNote, tooling } = parseTitle(title);
  return addsNote || tooling;
}

function toolingFileProblems(title: string, files: readonly string[]): string[] {
  const code = files.filter((file) => isShippedCode(file));
  if (code.length === 0) return [];
  return [`PR title "${title}" says tooling, but the PR changes shipped code: ${code.join(", ")}`];
}

function noteFileProblems(title: string, files: readonly string[]): string[] {
  if (files.some((file) => isShippedCode(file) || shippedConfig.has(file))) return [];
  return [
    `PR title "${title}" adds a release note, but the PR changes no shipped file: use chore, docs, test, or ci`,
  ];
}

/** `files` is absent when the diff base is unknown, which leaves only the check on the title. */
export function checkReleaseNote(title: string, files?: readonly string[]): string[] {
  const { addsNote, tooling } = parseTitle(title);
  const problems =
    addsNote && tooling
      ? [`PR title "${title}" adds a release note for tooling: use chore(tooling)`]
      : [];
  if (files === undefined) return problems;
  if (tooling) return [...problems, ...toolingFileProblems(title, files)];
  return addsNote ? noteFileProblems(title, files) : problems;
}

/** Without rename detection, a rename lists both paths, and a deleted file counts as changed. */
export function readChangedFiles(base: string, cwd: string = process.cwd()): string[] {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file !== "");
}
