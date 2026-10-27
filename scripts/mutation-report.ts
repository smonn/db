/**
 * Keeps one open `mutation-report` issue listing the mutants no test killed in the last Stryker
 * run: it rewrites that issue's body, opens it when none is open, and closes it when nothing
 * survives. A mutant with no covering test counts, since nothing kills it either.
 *
 * The run marks each `Stryker disable` comment first (`mark-stryker-disables.ts`), so Stryker
 * tests the mutants they hide. A survivor a marker expects stays off the list; a marker that finds
 * no surviving mutant of its mutator on the next line goes in a Stale disables section, which alone
 * keeps the issue open.
 *
 * Run with `GITHUB_REPOSITORY` set and `gh` authenticated, as `pnpm mutation:report [report...]`.
 * It reads `reports/mutation/mutation.json`, which `pnpm mutation` writes, unless given the
 * reports to merge; the Mutation workflow passes one per shard.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { array, field, number, parseJson, record, string, type Reader } from "./github-json.ts";
import { type Disable, markedDisables } from "./stryker-directive.ts";

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

/** A marked `Stryker disable` comment that hides no surviving mutant on the line below it. */
export type StaleDisable = { file: string; line: number; mutator: string; found: string };

export type Findings = { survivors: Survivor[]; stale: StaleDisable[] };

const isSurvivor = (status: string): status is Survivor["status"] =>
  status === "Survived" || status === "NoCoverage";

const byLocation = (a: { file: string; line: number }, b: { file: string; line: number }): number =>
  a.file.localeCompare(b.file) || a.line - b.line;

const hides = (disable: Disable, mutant: Mutant): boolean =>
  mutant.line === disable.line + 1 &&
  mutant.mutatorName.toLowerCase() === disable.mutator.toLowerCase();

function staleDisable(file: string, disable: Disable, mutants: Mutant[]): StaleDisable[] {
  const hidden = mutants.filter((mutant) => hides(disable, mutant));
  if (hidden.some(({ status }) => isSurvivor(status))) return [];
  const found =
    hidden.length === 0 ? "No mutant" : [...new Set(hidden.map(({ status }) => status))].join(", ");
  return [{ file, line: disable.line, mutator: disable.mutator, found }];
}

function fileFindings(file: string, mutants: Mutant[], source: string): Findings {
  const disables = markedDisables(source);
  return {
    survivors: mutants.flatMap((mutant) => {
      const { mutatorName, status, line } = mutant;
      const expected = disables.some((disable) => hides(disable, mutant));
      return isSurvivor(status) && !expected ? [{ file, line, mutator: mutatorName, status }] : [];
    }),
    stale: disables.flatMap((disable) => staleDisable(file, disable, mutants)),
  };
}

/**
 * The survived and uncovered mutants of a Stryker JSON report, by file then line, less those a
 * marked disable expects, and the marked disables that expect a survivor and find none.
 */
export function findings(report: unknown): Findings {
  const files = field(record(report, "$"), "files", record, "$");
  return mergeFindings(
    Object.entries(files).map(([file, entry]) => {
      const path = `$.files[${JSON.stringify(file)}]`;
      const fileReport = record(entry, path);
      const mutants = field(fileReport, "mutants", array(readMutant), path);
      return fileFindings(file, mutants, field(fileReport, "source", string, path));
    }),
  );
}

export const mergeFindings = (all: Findings[]): Findings => ({
  survivors: all.flatMap(({ survivors }) => survivors).toSorted(byLocation),
  stale: all.flatMap(({ stale }) => stale).toSorted(byLocation),
});

function staleSection(stale: StaleDisable[]): string[] {
  if (stale.length === 0) return [];
  return [
    "",
    "## Stale disables",
    "",
    "Each `Stryker disable` comment below hides no surviving mutant of its mutator on the next line. Delete it, or fix its mutator.",
    "",
    "| File | Line | Mutator | Found |",
    "| --- | --- | --- | --- |",
    ...stale.map(
      ({ file, line, mutator, found }) => `| \`${file}\` | ${line} | ${mutator} | ${found} |`,
    ),
  ];
}

export function reportBody(
  { survivors: list, stale }: Findings,
  maxLength: number = MAX_LENGTH,
): string {
  const lines = [
    `The weekly Stryker run leaves ${list.length} mutants that no test kills, and ${stale.length} stale disables. Each run rewrites this issue, and closes it once neither is left.`,
    ...staleSection(stale),
    ...(list.length === 0
      ? []
      : [
          "",
          "## Survivors",
          "",
          "| File | Line | Mutator | Status |",
          "| --- | --- | --- | --- |",
        ]),
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

export type Gh = (args: string[], input?: string) => string;

export const runGh: Gh = (args, input) =>
  execFileSync("gh", args, { encoding: "utf8", ...(input === undefined ? {} : { input }) });

const readNumbers: Reader<number[]> = array((value, path) =>
  field(record(value, path), "number", number, path),
);

export function openReportIssue(repo: string, gh: Gh): number | undefined {
  const args = ["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open"];
  const open = readNumbers(parseJson(gh([...args, "--json", "number"]), "gh issue list"), "$");
  if (open.length > 1) {
    throw new Error(
      `Several open ${LABEL} issues (${open.map((n) => `#${n}`).join(", ")}); close all but one`,
    );
  }
  return open[0];
}

function syncIssue(repo: string, issue: number | undefined, found: Findings, gh: Gh): void {
  if (found.survivors.length === 0 && found.stale.length === 0) {
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
  const found = mergeFindings(
    (reportPaths.length === 0 ? [REPORT] : reportPaths).map((path) =>
      findings(parseJson(readFileSync(path, "utf8"), path)),
    ),
  );
  syncIssue(repo, openReportIssue(repo, gh), found, gh);
}

if (import.meta.main) main(process.argv.slice(2));
