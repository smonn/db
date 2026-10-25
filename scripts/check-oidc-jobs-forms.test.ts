import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { checkOidcJobs, lockedPnpm } from "./check-oidc-jobs.ts";

const release = readFileSync(".github/workflows/release.yml", "utf8");
const pnpm = lockedPnpm(readFileSync("pnpm-lock.yaml", "utf8")) ?? "";
const check = (text: string): string[] => checkOidcJobs(text, "release.yml", pnpm);

function variant(from: string, to: string, text = release): string {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`Expected one "${from}" in release.yml.`);
  return parts.join(to);
}

const packGrant = "    permissions:\n      contents: read\n    env:";
const withPack = (grant: string): string =>
  variant(packGrant, `    permissions:\n      contents: read\n${grant}    env:`);
const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((line) => line.includes(needle)) + 1;

// Each grants id-token in a YAML form the line reader can't follow.
const forms: Record<string, [string, string]> = {
  "a next-line value": [withPack("      id-token:\n        write\n"), "      id-token:"],
  "an explicit key": [withPack("      ? id-token\n      : write\n"), "? id-token"],
  "an escaped key": [withPack('      "id\\x2Dtoken": write\n'), "x2D"],
  "an alias value": [
    variant(
      "      contents: write\n",
      "      contents: &w write\n",
      withPack("      id-token: *w\n"),
    ),
    "&w",
  ],
  "a !!str tag": [withPack("      id-token: !!str write\n"), "!!str"],
  "a flow map across lines": [
    variant(packGrant, '    permissions: { contents: read, "id-token"\n      : write }\n    env:'),
    'read, "id-token"',
  ],
  "a workflow-level next-line value": [
    variant("permissions: {}\n", "permissions:\n  id-token:\n    write\n"),
    "  id-token:",
  ],
  "an escaped permissions key": [
    variant(packGrant, '    "perm\\x69ssions":\n      "id\\x2Dtoken": write\n    env:'),
    "perm\\x69",
  ],
};

describe("checkOidcJobs on YAML forms", () => {
  test("accepts the current release.yml", () => {
    expect(check(release)).toEqual([]);
  });

  test.each(Object.entries(forms))("refuses id-token granted with %s", (_name, [text, needle]) => {
    expect(check(text)).toContainEqual(
      expect.stringMatching(`^release\\.yml line ${lineOf(text, needle)} `),
    );
  });

  test("refuses a non-breaking space that hides a run line from the template as a comment", () => {
    const text = variant(
      "          empty=$(mktemp -d)\n",
      "          empty=$(mktemp -d)\n          \u00A0#||echo PWNED\n",
    );
    expect(check(text)).toEqual([
      `release.yml line ${lineOf(text, "PWNED")} holds U+00A0, outside printable ASCII; this check reads printable ASCII only`,
    ]);
  });
});
