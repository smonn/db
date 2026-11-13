/**
 * The checks over repository data: `check:pr` over the last merged pull requests, each judged at its
 * merge commit; `check:branch` over the remote branch names; `check:oidc` over the workflow files.
 * Each reports through `console.error` and the exit code, which `captureRefusals` reads. None writes
 * to GitHub.
 */
import { main as checkBranch } from "./check-branch.ts";
import { readOpenPrAdds } from "./check-adr-clash.ts";
import { main as checkOidc } from "./check-oidc-jobs.ts";
import { main as checkPr, readChangedAdrs, type ChangedAdr } from "./check-pr.ts";
import { readChangedFiles } from "./check-release-note.ts";
import { captureRefusals, type Check, type Probe } from "./live-input-probe.ts";
import type { MergedPr, Source } from "./live-input-source.ts";

export type PrReaders = {
  adrs: (base: string, cwd: string) => ChangedAdr[];
  files: (base: string, cwd: string) => string[];
};

const gitReaders: PrReaders = { adrs: readChangedAdrs, files: readChangedFiles };

function prEnv(pr: MergedPr): NodeJS.ProcessEnv {
  return {
    PR_TITLE: pr.title,
    PR_BRANCH: pr.branch,
    PR_BODY: pr.body,
    PR_NUMBER: String(pr.number),
    PR_DIFF_BASE: `${pr.oid}^1`,
  };
}

export function prProbes(source: Source, readers: PrReaders = gitReaders): Probe[] {
  return source.mergedPrs().map((pr) => ({
    check: "check:pr",
    sample: `#${pr.number} ${pr.title}`,
    run: () => {
      const cwd = source.checkoutAt(pr.oid);
      return captureRefusals(() => {
        checkPr(
          prEnv(pr),
          (base) => readers.adrs(base, cwd),
          readOpenPrAdds,
          (base) => readers.files(base, cwd),
        );
      });
    },
  }));
}

const NONZERO_SHA = "1".repeat(40);
const ZERO_SHA = "0".repeat(40);

export function branchProbes(source: Source): Probe[] {
  return source.branches().map((branch) => ({
    check: "check:branch",
    sample: branch,
    run: () => {
      const ref = `refs/heads/${branch}`;
      return captureRefusals(() => {
        checkBranch(`${ref} ${NONZERO_SHA} ${ref} ${ZERO_SHA}\n`);
      });
    },
  }));
}

function oidcProbes(): Probe[] {
  return [
    {
      check: "check:oidc",
      sample: ".github/workflows/*.yml",
      run: () =>
        captureRefusals(() => {
          checkOidc();
        }),
    },
  ];
}

const PR_FILES = [
  "scripts/check-adr-clash.ts",
  "scripts/check-closing-keywords.ts",
  "scripts/check-pr.ts",
  "scripts/check-release-note.ts",
  "scripts/github-json.ts",
];

export const REPO_CHECKS: Check[] = [
  { name: "check:pr", files: PR_FILES, probes: prProbes },
  {
    name: "check:branch",
    files: [
      "scripts/check-adr-clash.ts",
      "scripts/check-branch.ts",
      "scripts/check-closing-keywords.ts",
      "scripts/check-pr.ts",
      "scripts/check-release-note.ts",
      "scripts/github-json.ts",
    ],
    probes: branchProbes,
  },
  {
    name: "check:oidc",
    files: [
      "scripts/check-oidc-jobs.ts",
      "scripts/workflow-permissions.ts",
      "scripts/workflow-yaml-flow.ts",
      "scripts/workflow-yaml.ts",
    ],
    probes: oidcProbes,
  },
];
