import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkOidcJobs, main } from "./check-oidc-jobs.ts";

const download = `      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: package
`;
const setup = `      - uses: pnpm/setup@a0881977cd8ea73b1ed212236c99ca10dcc80cf4 # v3.1.1
        with:
          install: false
`;
const publish = `      - run: pnpm stage publish --ignore-scripts --no-git-checks package.tgz\n`;

function workflow(steps: string, permissions = "      id-token: write\n"): string {
  return `name: Release

permissions: {}

jobs:
  pack:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: pnpm pack

  publish:
    needs: pack
    runs-on: ubuntu-24.04
    permissions:
      contents: read
${permissions}    steps:
${steps}`;
}

describe("checkOidcJobs", () => {
  test("accepts a job that downloads, sets up pnpm without install, and publishes", () => {
    expect(checkOidcJobs(workflow(download + setup + publish), "release.yml")).toEqual([]);
  });

  test("ignores install and build steps in a job without id-token", () => {
    const steps = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - run: pnpm install\n`;
    expect(checkOidcJobs(workflow(steps, ""), "release.yml")).toEqual([]);
  });

  test("flags a checkout in a job with id-token", () => {
    const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
    expect(checkOidcJobs(workflow(checkout + setup + publish), "release.yml")).toEqual([
      "release.yml job publish holds id-token and uses actions/checkout; allowed: actions/download-artifact, pnpm/setup",
    ]);
  });

  test("flags pnpm/setup without install: false", () => {
    const installs = `      - uses: pnpm/setup@a0881977cd8ea73b1ed212236c99ca10dcc80cf4 # v3.1.1\n`;
    expect(checkOidcJobs(workflow(download + installs + publish), "release.yml")).toEqual([
      "release.yml job publish holds id-token and runs pnpm/setup without install: false",
    ]);
  });

  test("flags pnpm/setup whose install: false belongs to a later step", () => {
    const installs = `      - uses: pnpm/setup@a0881977cd8ea73b1ed212236c99ca10dcc80cf4 # v3.1.1\n`;
    expect(checkOidcJobs(workflow(installs + setup + publish), "release.yml")).toEqual([
      "release.yml job publish holds id-token and runs pnpm/setup without install: false",
    ]);
  });

  test.each([
    "pnpm install",
    "pnpm run build",
    "pnpm stage publish --no-git-checks package.tgz",
    "pnpm publish package.tgz",
    "pnpm stage publish package.tgz && pnpm install --ignore-scripts",
  ])("flags the run step %s", (command) => {
    const steps = `${download + setup}      - run: ${command}\n`;
    expect(checkOidcJobs(workflow(steps), "release.yml")).toEqual([
      `release.yml job publish holds id-token and runs "${command}"; allowed: pnpm publish or pnpm stage publish with --ignore-scripts`,
    ]);
  });

  test("accepts pnpm publish with --ignore-scripts", () => {
    const steps = `${download + setup}      - run: pnpm publish --ignore-scripts package.tgz\n`;
    expect(checkOidcJobs(workflow(steps), "release.yml")).toEqual([]);
  });

  test("flags a multi-line run step, which the check cannot read", () => {
    const steps = `${download + setup}      - run: |\n          pnpm stage publish --ignore-scripts package.tgz\n`;
    expect(checkOidcJobs(workflow(steps), "release.yml")).toEqual([
      'release.yml job publish holds id-token and runs "|"; allowed: pnpm publish or pnpm stage publish with --ignore-scripts',
    ]);
  });

  test("flags a job whose steps sit at an indent the check does not read", () => {
    const steps = `    - run: pnpm install\n`;
    expect(checkOidcJobs(workflow(steps), "release.yml")).toEqual([
      "release.yml job publish holds id-token and has no steps at six-space indent to check",
    ]);
  });

  test.each(["permissions:\n  id-token: write", "permissions: write-all"])(
    "flags id-token granted to the whole workflow by %s",
    (grant) => {
      const text = workflow(download + setup + publish).replace("permissions: {}", grant);
      expect(checkOidcJobs(text, "release.yml")).toEqual([
        "release.yml grants id-token outside a job; grant it to the publish job only",
      ]);
    },
  );

  test("reads a workflow with no jobs as all header", () => {
    expect(checkOidcJobs("permissions:\n  id-token: write\n", "release.yml")).toEqual([
      "release.yml grants id-token outside a job; grant it to the publish job only",
    ]);
  });

  test("flags id-token granted after the jobs block at top level", () => {
    const text = `${workflow(download + setup + publish)}permissions: write-all\n`;
    expect(checkOidcJobs(text, "release.yml")).toEqual([
      "release.yml grants id-token outside a job; grant it to the publish job only",
    ]);
  });

  test("checks the steps of a job granted write-all, which includes id-token", () => {
    const text = workflow(`${download + setup}      - run: pnpm install\n`, "").replace(
      "    permissions:\n      contents: read\n",
      "    permissions: write-all\n",
    );
    expect(checkOidcJobs(text, "release.yml")).toEqual([
      "release.yml job publish grants write-all, which includes id-token",
      'release.yml job publish holds id-token and runs "pnpm install"; allowed: pnpm publish or pnpm stage publish with --ignore-scripts',
    ]);
  });
});

describe("main", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function setupRepo(files: Record<string, string>): void {
    dir = mkdtempSync(join(tmpdir(), "check-oidc-jobs-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, ".github", "workflows", name), text);
  }

  test("passes on this repo's workflows", () => {
    main(".");
    expect(process.exitCode).toBeUndefined();
  });

  test("prints each problem with its file and sets exit code 1", () => {
    setupRepo({
      "release.yml": workflow(`${setup}      - run: pnpm install\n`),
      "notes.txt": "id-token: write",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    main(dir);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("release.yml job publish"));
    expect(process.exitCode).toBe(1);
  });
});
