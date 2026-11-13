/**
 * The live samples `live-input-checks.ts` runs the repo checks over: the open issues, the last
 * merged pull requests, the remote branches, and a detached checkout at a merge commit. Every
 * read goes through `gh api` (a GET) or `gh pr list`, so the workflow's read-only token is enough.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  array,
  field,
  number,
  optionalField,
  parseJson,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export type IssueSample = { number: number; title: string; raw: Record<string, unknown> };

export type MergedPr = {
  number: number;
  title: string;
  body: string;
  branch: string;
  mergedAt: string;
  oid: string;
};

export type Source = {
  repo: string;
  /** Runs `gh` and returns its output. Only a GET reaches it; see `readOnlyGh`. */
  gh: (args: string[]) => string;
  issues: () => IssueSample[];
  mergedPrs: () => MergedPr[];
  branches: () => string[];
  /** A directory holding the repository at `oid`, for the checks that read the working tree. */
  checkoutAt: (oid: string) => string;
  /** A directory for files a check reads by path, such as an event payload. */
  scratch: () => string;
  close: () => void;
};

type Gh = Source["gh"];

const MERGED_PR_COUNT = 30;

const readIssueSample: Reader<IssueSample> = (value, path) => {
  const raw = record(value, path);
  return {
    number: field(raw, "number", number, path),
    title: field(raw, "title", string, path),
    raw,
  };
};

const readMergedPr: Reader<MergedPr> = (value, path) => {
  const pr = record(value, path);
  return {
    number: field(pr, "number", number, path),
    title: field(pr, "title", string, path),
    body: field(pr, "body", string, path),
    branch: field(pr, "headRefName", string, path),
    mergedAt: field(pr, "mergedAt", string, path),
    oid: field(pr, "mergeCommit", (commit, p) => field(record(commit, p), "oid", string, p), path),
  };
};

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

/** The pages `gh api --paginate --slurp` returns, flattened. */
function pages(gh: Gh, path: string): unknown[] {
  const text = gh(["api", "--paginate", "--slurp", path]);
  return array(array((item) => item))(parseJson(text, `gh api ${path}`), path).flat();
}

// The issue list holds pull requests too.
function isIssue(item: unknown): boolean {
  return optionalField(record(item, "$"), "pull_request", record, "$") === undefined;
}

function openIssues(gh: Gh, repo: string): IssueSample[] {
  return pages(gh, `repos/${repo}/issues?state=open&per_page=100`)
    .filter((item) => isIssue(item))
    .map((item) => readIssueSample(item, "$"));
}

// `gh pr list` sorts by creation, so read more than needed and keep the last merged.
function lastMergedPrs(gh: Gh): MergedPr[] {
  const fields = "number,title,body,headRefName,mergedAt,mergeCommit";
  const json = gh([
    "pr",
    "list",
    "--state",
    "merged",
    "--base",
    "main",
    "--limit",
    "100",
    "--json",
    fields,
  ]);
  return array(readMergedPr)(parseJson(json, "gh pr list"), "merged pull requests")
    .toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, MERGED_PR_COUNT);
}

// The default branch is no pushed work branch: `check:branch` would refuse `main` on every run.
function workBranches(gh: Gh, repo: string): string[] {
  const text = gh(["api", `repos/${repo}`]);
  const defaultBranch = field(
    record(parseJson(text, `gh api repos/${repo}`), "$"),
    "default_branch",
    string,
    "$",
  );
  return pages(gh, `repos/${repo}/branches?per_page=100`)
    .map((item) => field(record(item, "$"), "name", string, "$"))
    .filter((name) => name !== defaultBranch);
}

export function realSource(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): Source {
  const { GITHUB_REPOSITORY: repo } = env;
  if (repo === undefined || repo === "") throw new Error("Set GITHUB_REPOSITORY");
  const gh: Gh = (args) =>
    execFileSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const git = (args: string[], at: string = cwd): string =>
    execFileSync("git", args, { cwd: at, encoding: "utf8" });
  const made: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  const worktree = once(() => {
    const dir = tempDir("live-input-worktree-");
    git(["worktree", "add", "--detach", dir, "HEAD"]);
    return dir;
  });
  return {
    repo,
    gh,
    issues: once(() => openIssues(gh, repo)),
    mergedPrs: once(() => lastMergedPrs(gh)),
    branches: once(() => workBranches(gh, repo)),
    checkoutAt: (oid) => {
      git(["checkout", "--quiet", "--detach", oid], worktree());
      return worktree();
    },
    scratch: once(() => tempDir("live-input-checks-")),
    close: () => {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
      git(["worktree", "prune"]);
    },
  };
}
