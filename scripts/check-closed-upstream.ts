/**
 * Lists each open issue whose body or comments cite another repository's issue or pull request that
 * is now closed, and exits 1 when there is one. An issue that waits on an upstream change never
 * hears the change land (#699: postgres.js shipped the fix #364 waited on, and a manual look found
 * it a day later). A citation is `owner/repo#n` or a github.com `/issues/n` or `/pull/n` URL;
 * references to the issue's own repository and to pull requests filed here are not checked. A
 * reference GitHub answers with 404, such as a private repository or text that only looks like a
 * reference, is warned about on stderr and left out of the list.
 *
 * Run with `gh` authenticated, as `pnpm check:upstream`; the Closed upstream references workflow
 * runs it weekly. It reads the live issue list, so `pnpm check` leaves it out.
 */
import { spawnSync } from "node:child_process";
import {
  array,
  field,
  literal,
  nullable,
  number,
  optionalField,
  parseJson,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export type Reference = { repo: string; number: number };

// A repository name may hold a dot (`vercel/next.js`), but one ending in a docs or source file
// extension is a path with an anchor, such as `docs/foo.md#2`.
const SHORTHAND =
  /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)(?<!\.(?:md|mts|ts|tsx|json|ya?ml))#(\d+)(?!\w)/gu;
const URL_FORM =
  /https?:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)/gu;

function key(reference: Reference): string {
  // Stryker disable next-line MethodExpression: 1 survivor: upper case folds repository names as well as lower case does.
  return `${reference.repo.toLowerCase()}#${reference.number}`;
}

/** Each distinct `owner/repo#n` or github.com issue or pull URL in `text` outside `ownRepo`, in order of first appearance. */
export function findReferences(text: string, ownRepo: string): Reference[] {
  const found = new Map<string, Reference>();
  const matches = [...text.matchAll(SHORTHAND), ...text.matchAll(URL_FORM)].toSorted(
    (a, b) => a.index - b.index,
  );
  // Stryker disable next-line StringLiteral: 2 survivors: both groups always match, so the fallbacks never run.
  for (const [, repo = "", digits = ""] of matches) {
    const reference = { repo, number: Number(digits) };
    if (repo.toLowerCase() === ownRepo.toLowerCase() || found.has(key(reference))) continue;
    found.set(key(reference), reference);
  }
  return [...found.values()];
}

export type Issue = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  body: string | null;
  comments: number;
  pull_request?: object | undefined;
};

export type Comment = { html_url: string; body: string };

export type Upstream = { state: "open" | "closed"; html_url: string };

export const readIssue: Reader<Issue> = (value, path) => {
  const issue = record(value, path);
  return {
    number: field(issue, "number", number, path),
    title: field(issue, "title", string, path),
    html_url: field(issue, "html_url", string, path),
    repository_url: field(issue, "repository_url", string, path),
    body: field(issue, "body", nullable(string), path),
    comments: field(issue, "comments", number, path),
    pull_request: optionalField(issue, "pull_request", record, path),
  };
};

const readComment: Reader<Comment> = (value, path) => {
  const comment = record(value, path);
  return {
    html_url: field(comment, "html_url", string, path),
    body: field(comment, "body", string, path),
  };
};

const readUpstream: Reader<Upstream> = (value, path) => {
  const upstream = record(value, path);
  return {
    state: field(upstream, "state", literal("open", "closed"), path),
    html_url: field(upstream, "html_url", string, path),
  };
};

class GhError extends Error {
  readonly notFound: boolean;

  constructor(path: string, stderr: string) {
    super(`gh api ${path} failed:\n${stderr.trim()}`);
    this.notFound = stderr.includes("HTTP 404");
  }
}

function gh(path: string, flags: string[] = []): string {
  const result = spawnSync("gh", ["api", ...flags, path], { encoding: "utf8" });
  if (result.status !== 0) throw new GhError(path, result.stderr);
  return result.stdout;
}

function getAll<T>(path: string, read: Reader<T>): T[] {
  const pages = parseJson(gh(path, ["--paginate", "--slurp"]), `gh api ${path}`);
  return array(array(read))(pages, "$").flat();
}

function lookup(reference: Reference): Upstream | undefined {
  const path = `repos/${reference.repo}/issues/${reference.number}`;
  try {
    return readUpstream(parseJson(gh(path), `gh api ${path}`), "$");
  } catch (error) {
    if (error instanceof GhError && error.notFound) return undefined;
    throw error;
  }
}

type Citation = { issue: Issue; reference: Reference; at: string };

function repoOf(issue: Issue): string {
  return issue.repository_url.replace("https://api.github.com/repos/", "");
}

function citations(issue: Issue): Citation[] {
  const repo = repoOf(issue);
  // Stryker disable next-line StringLiteral: 1 survivor: any text without a reference reads as no body.
  const sources = [{ at: issue.html_url, text: issue.body ?? "" }];
  if (issue.comments > 0) {
    const comments = getAll(
      `repos/${repo}/issues/${issue.number}/comments?per_page=100`,
      readComment,
    );
    sources.push(...comments.map((comment) => ({ at: comment.html_url, text: comment.body })));
  }
  const seen = new Set<string>();
  const found: Citation[] = [];
  for (const { at, text } of sources) {
    for (const reference of findReferences(text, repo)) {
      if (seen.has(key(reference))) continue;
      seen.add(key(reference));
      found.push({ issue, reference, at });
    }
  }
  return found;
}

export function formatCitation({ issue, reference, at }: Citation, upstream: Upstream): string {
  return `#${issue.number} cites ${reference.repo}#${reference.number}, closed (${upstream.html_url}); cited in ${at}`;
}

/** The lines to print for each open issue's citation of a closed upstream issue or pull request. */
export function closedCitations(issues: Issue[]): { closed: string[]; unreadable: string[] } {
  const upstreams = new Map<string, Upstream | undefined>();
  const closed: string[] = [];
  const unreadable: string[] = [];
  for (const issue of issues.filter((candidate) => candidate.pull_request === undefined)) {
    for (const citation of citations(issue)) {
      const id = key(citation.reference);
      if (!upstreams.has(id)) upstreams.set(id, lookup(citation.reference));
      const upstream = upstreams.get(id);
      if (upstream === undefined) {
        unreadable.push(
          `warning: #${issue.number} cites ${citation.reference.repo}#${citation.reference.number}, which GitHub does not return (404)`,
        );
      } else if (upstream.state === "closed") closed.push(formatCitation(citation, upstream));
    }
  }
  return { closed, unreadable };
}

export function main(): void {
  try {
    const issues = getAll("repos/{owner}/{repo}/issues?state=open&per_page=100", readIssue);
    const { closed, unreadable } = closedCitations(issues);
    for (const line of unreadable) console.warn(line);
    console.log(
      closed.length > 0 ? closed.join("\n") : "No open issue cites a closed upstream issue.",
    );
    if (closed.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
