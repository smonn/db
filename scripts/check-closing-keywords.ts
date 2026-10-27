/**
 * Finds closing keywords in a PR body that point outside `smonn/db`. GitHub closes the issue a
 * closing keyword names, even in another repository, so a body that cites one by mistake can close
 * it on merge (#505). Only the keyword directly followed by the reference counts; a plain mention
 * passes.
 */
const home = "smonn/db";
const slug = "[\\w.-]+/[\\w.-]+";
const keyword = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const closingPattern = new RegExp(
  `\\b${keyword}:?\\s+(?:(${slug})#(\\d+)|https://github\\.com/(${slug})/(?:issues|pull)/(\\d+))`,
  "giu",
);

export function checkClosingKeywords(body: string): string[] {
  return [...body.matchAll(closingPattern)].flatMap(
    ([match, shortRepo, shortNumber, urlRepo, urlNumber]) => {
      // Stryker disable next-line StringLiteral: 1 survivor: the pattern's alternation always captures one of the two repos, so the fallback only satisfies the type checker.
      const repo = shortRepo ?? urlRepo ?? "";
      if (repo.toLowerCase() === home) return [];
      return [`PR body closes ${repo}#${shortNumber ?? urlNumber} outside ${home}: "${match}"`];
    },
  );
}
