/**
 * Keeps one open `mutation-report` issue listing the mutants no test killed in the last Stryker
 * run: it rewrites that issue's body, opens it when none is open, and closes it when nothing
 * survives. A mutant with no covering test counts, since nothing kills it either.
 *
 * Run with `GITHUB_REPOSITORY` set and `gh` authenticated, as `pnpm mutation:report [report...]`.
 * It reads `reports/mutation/mutation.json`, which `pnpm mutation` writes, unless given the
 * reports to merge; the Mutation workflow passes one per shard.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { array, field, number, parseJson, record, string, type Reader } from "./github-json.ts";

export type Survivor = {
  file: string;
  line: number;
  mutator: string;
  status: "Survived" | "NoCoverage";
};

const REPORT = "reports/mutation/mutation.json";
const LABEL = "mutation-report";
const TITLE = "Mutants survive the weekly Stryker run";
// GitHub caps an issue body at 65,536 characters; this leaves room for the footer.
const MAX_LENGTH = 60_000;

type Mutant = { mutatorName: string; status: string; line: number };

const readMutant: Reader<Mutant> = (value, path) => {
  const mutant = record(value, path);
  const start = record(
    record(mutant["location"], `${path}.location`)["start"],
    `${path}.location.start`,
  );
  return {
    mutatorName: field(mutant, "mutatorName", string, path),
    status: field(mutant, "status", string, path),
    line: field(start, "line", number, `${path}.location.start`),
  };
};

const isSurvivor = (status: string): status is Survivor["status"] =>
  status === "Survived" || status === "NoCoverage";

const byLocation = (a: Survivor, b: Survivor): number =>
  a.file.localeCompare(b.file) || a.line - b.line;

/** The survived and uncovered mutants of a Stryker JSON report, by file then line. */
export function survivors(report: unknown): Survivor[] {
  const files = field(record(report, "$"), "files", record, "$");
  return Object.entries(files)
    .flatMap(([file, entry]) => {
      const path = `$.files[${JSON.stringify(file)}]`;
      return field(record(entry, path), "mutants", array(readMutant), path).flatMap(
        ({ mutatorName, status, line }) =>
          isSurvivor(status) ? [{ file, line, mutator: mutatorName, status }] : [],
      );
    })
    .toSorted(byLocation);
}

export function reportBody(list: Survivor[], maxLength: number = MAX_LENGTH): string {
  const lines = [
    `The weekly Stryker run leaves ${list.length} mutants that no test kills. Each run rewrites this issue, and closes it once none survive.`,
    "",
    "| File | Line | Mutator | Status |",
    "| --- | --- | --- | --- |",
  ];
  let length = lines.join("\n").length;
  let shown = 0;
  for (const { file, line, mutator, status } of list) {
    const row = `| \`${file}\` | ${line} | ${mutator} | ${status} |`;
    if (length + row.length + 1 > maxLength) break;
    lines.push(row);
    length += row.length + 1;
    shown += 1;
  }
  if (shown < list.length) {
    lines.push(
      "",
      `${list.length - shown} more not shown; the run's \`mutation-report-*\` artifacts list them all.`,
    );
  }
  return [...lines, ""].join("\n");
}

type Gh = (args: string[], input?: string) => string;

const runGh: Gh = (args, input) =>
  execFileSync("gh", args, { encoding: "utf8", ...(input === undefined ? {} : { input }) });

const readNumbers: Reader<number[]> = array((value, path) =>
  field(record(value, path), "number", number, path),
);

function openReportIssue(repo: string, gh: Gh): number | undefined {
  const args = ["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open"];
  const open = readNumbers(parseJson(gh([...args, "--json", "number"]), "gh issue list"), "$");
  if (open.length > 1) {
    throw new Error(
      `Several open ${LABEL} issues (${open.map((n) => `#${n}`).join(", ")}); close all but one`,
    );
  }
  return open[0];
}

function syncIssue(repo: string, issue: number | undefined, found: Survivor[], gh: Gh): void {
  if (found.length === 0) {
    if (issue === undefined) return;
    const comment = "No mutants survive the latest Stryker run.";
    gh(["issue", "close", String(issue), "--repo", repo, "--comment", comment]);
    return;
  }
  const body = reportBody(found);
  if (issue === undefined) {
    gh(
      ["issue", "create", "--repo", repo, "--title", TITLE, "--label", LABEL, "--body-file", "-"],
      body,
    );
  } else {
    gh(["issue", "edit", String(issue), "--repo", repo, "--body-file", "-"], body);
  }
}

export function main(
  reportPaths: string[],
  env: NodeJS.ProcessEnv = process.env,
  gh: Gh = runGh,
): void {
  const { GITHUB_REPOSITORY: repo } = env;
  if (repo === undefined) {
    console.error("Set GITHUB_REPOSITORY");
    process.exitCode = 1;
    return;
  }
  const found = (reportPaths.length === 0 ? [REPORT] : reportPaths)
    .flatMap((path) => survivors(parseJson(readFileSync(path, "utf8"), path)))
    .toSorted(byLocation);
  syncIssue(repo, openReportIssue(repo, gh), found, gh);
}

if (import.meta.main) main(process.argv.slice(2));
