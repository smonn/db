import { describe, expect, test } from "vitest";
import { checkOidcJobs, lockedPnpm, pinnedSha } from "./check-oidc-jobs.ts";

const download = pinnedSha("actions/download-artifact");
const setup = pinnedSha("pnpm/setup");

const publish = `  publish:
    name: Publish
    needs: pack
    runs-on: ubuntu-24.04
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@${download} # pinned
        with:
          name: package
          path: \${{ runner.temp }}/pkg
      - uses: pnpm/setup@${setup} # pinned
        with:
          version: 12.14.0
          install: false
      - run: |
          test -f "$RUNNER_TEMP/pkg/package.tgz"
          test ! -L "$RUNNER_TEMP/pkg/package.tgz"
          empty=$(mktemp -d)
          cd "$empty"
          pnpm stage publish --ignore-scripts --no-git-checks "$RUNNER_TEMP/pkg/package.tgz"
`;

const workflow = (header = "permissions: {}\n", tail = ""): string =>
  `name: Release\n${header}\njobs:\n  pack:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: pnpm install\n\n${publish}${tail}`;

const check = (text: string): string[] => checkOidcJobs(text, "release.yml", "12.14.0");
const outside = "release.yml grants id-token outside a job; grant it to the publish job only";

describe("the id-token grant", () => {
  test.each(["  id-token : write", "  id-token:    write", '  "id-token" :   "write"'])(
    "is found in the form %j",
    (grant) => {
      expect(check(`permissions:\n${grant}\n`)).toEqual([outside]);
    },
  );

  test("is not found in a different key or value", () => {
    expect(check("permissions:\n  id-tokens: write\n  id-token: read\n")).toEqual([]);
  });

  test("is refused as write-all with several spaces after the colon", () => {
    expect(check("permissions:   write-all\n")).toEqual([
      "release.yml grants write-all, which includes id-token; grant id-token alone",
    ]);
  });
});

describe("workflow-level settings", () => {
  test.each([
    ['"env":\n  A: b', "env"],
    ["'defaults':\n  run: {}", "defaults"],
    ["env :\n  A: b", "env"],
  ])("refuses %j beside a job holding id-token", (setting, key) => {
    expect(check(workflow(`permissions: {}\n${setting}\n`))).toEqual([
      `release.yml sets workflow-level ${key}, which reaches the job holding id-token`,
    ]);
  });

  test("lets an indented key named env pass", () => {
    const header =
      "permissions: {}\non:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: string\n";
    expect(check(workflow(header))).toEqual([]);
  });

  test("lets a workflow without id-token set env", () => {
    expect(check("env:\n  A: b\njobs:\n  a:\n    runs-on: x\n")).toEqual([]);
  });

  test("reports both the grant and the env of a workflow with no jobs", () => {
    expect(check("env:\n  A: b\npermissions:\n  id-token: write\n")).toEqual([
      outside,
      "release.yml sets workflow-level env, which reaches the job holding id-token",
    ]);
  });
});

describe("job boundaries", () => {
  test("ends the jobs at the next top-level key and reads that key as header", () => {
    expect(check(workflow("permissions: {}\n", "concurrency:\n  group: release\n"))).toEqual([]);
    expect(check(workflow("permissions: {}\n", "env:\n  A: b\n"))).toEqual([
      "release.yml sets workflow-level env, which reaches the job holding id-token",
    ]);
  });

  test("reads a jobs: key with nothing after it", () => {
    expect(check("permissions:\n  id-token: write\njobs:\n")).toEqual([outside]);
  });

  test("reads a jobs: key that has a trailing value", () => {
    expect(check(workflow().replace("jobs:", "jobs: {}"))).toEqual([]);
  });

  test("reads a jobs: key that has a comment after it", () => {
    expect(check(workflow().replace("jobs:", "jobs:   # the jobs"))).toEqual([]);
  });

  test("does not read an indented jobs: as the jobs key", () => {
    const header =
      "permissions: {}\non:\n  workflow_dispatch:\n    inputs:\n      jobs:\n        type: string\n";
    expect(check(workflow(header))).toEqual([]);
  });

  test("ignores a whitespace-only line inside the job", () => {
    expect(check(workflow().replace("      - run: |\n", "      - run: |\n   \n"))).toEqual([]);
  });

  test("names the end of the job when it runs past the template", () => {
    const text = workflow("permissions: {}\n", "      - run: pnpm install\n");
    expect(check(text)).toEqual([
      'release.yml job publish holds id-token but differs from publishJob in scripts/check-oidc-jobs.ts at its line 22: expected "the end of the job", found "    - run: pnpm install"',
    ]);
  });
});

const lock = (key: string, version: string): string =>
  `importers:\n\n  .:\n${key}\n      pnpm:\n        specifier: ^12.14.0\n        version: ${version}\n`;

describe("lockedPnpm shapes", () => {
  test("reads the entry only at its own indentation and to the end of the line", () => {
    expect(lockedPnpm(lock("    packageManagerDependencies:", "12.14.0"))).toBe("12.14.0");
    expect(lockedPnpm(lock("      packageManagerDependencies:", "12.14.0"))).toBeUndefined();
    expect(lockedPnpm(lock("    packageManagerDependencies:", "12.14.0 # pinned"))).toBeUndefined();
  });
});
