/**
 * Finds the ADR numbers a pull request shares with other open pull requests. docs/adr/TEMPLATE.md
 * numbers an ADR one past the highest on `main` or in an open PR, but two PRs drafted at once pick
 * the same number and both pass CI; the clash shows up on `main` after the second merges. Used by
 * check-pr.ts, which passes the PR's own number so the open-PR list leaves it out.
 */
import { execFileSync } from "node:child_process";
import { array, field, number, parseJson, record, string } from "./github-json.ts";

const adrPathPattern = /^docs\/adr\/(\d{4})-.+\.md$/u;

export type OpenPrAdd = { pr: number; file: string };

const adrNumber = (file: string): string | undefined => adrPathPattern.exec(file)?.[1];

export function checkAdrClash(
  adrs: readonly { file: string; added: boolean }[],
  others: readonly OpenPrAdd[],
): string[] {
  return adrs
    .filter((adr) => adr.added)
    .flatMap((adr) =>
      others
        .filter((other) => adrNumber(other.file) === adrNumber(adr.file))
        .map(
          (other) =>
            `${adr.file} reuses ADR number ${adrNumber(adr.file)}, which open PR #${other.pr} adds as ${other.file}`,
        ),
    );
}

export function readOpenPrAdds(exclude: string, cwd: string = process.cwd()): OpenPrAdd[] {
  const json = execFileSync(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,files"],
    { cwd, encoding: "utf8" },
  );
  const prs = array((value, path) => {
    const pr = record(value, path);
    return {
      number: field(pr, "number", number, path),
      files: field(
        pr,
        "files",
        array((item, itemPath) => {
          const file = record(item, itemPath);
          return {
            path: field(file, "path", string, itemPath),
            changeType: field(file, "changeType", string, itemPath),
          };
        }),
        path,
      ),
    };
  })(parseJson(json, "gh pr list"), "open pull requests");
  return prs
    .filter((pr) => String(pr.number) !== exclude)
    .flatMap((pr) =>
      pr.files
        .filter((file) => file.changeType === "ADDED" && adrPathPattern.test(file.path))
        .map((file) => ({ pr: pr.number, file: file.path })),
    );
}
