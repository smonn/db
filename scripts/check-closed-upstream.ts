/**
 * Lists each open issue whose body or comments cite another repository's issue or pull request that
 * is now closed, and exits 1 when there is one. An issue that waits on an upstream change never
 * hears the change land (#699: postgres.js shipped the fix #364 waited on, and a manual look found
 * it a day later). A citation is `owner/repo#n` or a github.com `/issues/n` or `/pull/n` URL;
 * references to the issue's own repository and to pull requests filed here are not checked. A
 * reference GitHub answers with 403, 404, or 410, such as a private repository, a deleted issue, or
 * text that only looks like a reference, is warned about on stderr and in the step summary and left
 * out of the list. A 403 that names a rate limit still aborts the run.
 *
 * An issue keeps a deliberate citation by acknowledging it, in its body or a comment, with
 * `<!-- smonn-db:upstream-ack owner/repo#n -->`: the marker takes any references the check reads,
 * and any text after them.
 *
 * Run with `gh` authenticated, as `pnpm check:upstream`; the Closed upstream references workflow
 * runs it weekly. It reads the live issue list, so `pnpm check` leaves it out.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
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

// A status that says only that this reference can't be read. Any other failure aborts the run.
const UNREADABLE_STATUSES = new Set([403, 404, 410]);

class GhError extends Error {
  /** The HTTP status `gh` reports, when this failure is one a reference can't be read for. */
  readonly unreadable: number | undefined;

  constructor(path: string, stderr: string) {
    super(`gh api ${path} failed:\n${stderr.trim()}`);
    const status = Number(/\(HTTP (\d{3})\)/u.exec(stderr)?.[1]);
    const rateLimited = /rate limit/iu.test(stderr);
    this.unreadable = UNREADABLE_STATUSES.has(status) && !rateLimited ? status : undefined;
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

/** A reference GitHub won't return, with the HTTP status it answered. */
export type Unreadable = { unreadable: number };

/** Reads the state of a cited issue or pull request, or says GitHub does not return it. */
export type Lookup = (reference: Reference) => Upstream | Unreadable;

export function lookupUpstream(reference: Reference): Upstream | Unreadable {
  const path = `repos/${reference.repo}/issues/${reference.number}`;
  try {
    return readUpstream(parseJson(gh(path), `gh api ${path}`), "$");
  } catch (error) {
    if (error instanceof GhError && error.unreadable !== undefined) {
      return { unreadable: error.unreadable };
    }
    throw error;
  }
}

/** `lookup`, asked once per reference however often it is cited, also across issues. */
export function memoized(lookup: Lookup): Lookup {
  const answers = new Map<string, Upstream | Unreadable>();
  return (reference) => {
    const id = key(reference);
    const known = answers.get(id);
    if (known !== undefined) return known;
    const answer = lookup(reference);
    answers.set(id, answer);
    return answer;
  };
}

type Citation = { issue: Issue; reference: Reference; at: string };

function repoOf(issue: Issue): string {
  return issue.repository_url.replace("https://api.github.com/repos/", "");
}

const ACKNOWLEDGEMENT = /<!--\s*smonn-db:upstream-ack\b[\s\S]*?-->/gu;

/** The keys of the references an acknowledgement marker in `texts` covers. */
function acknowledged(texts: string[], repo: string): Set<string> {
  const covered = new Set<string>();
  for (const text of texts) {
    for (const [marker] of text.matchAll(ACKNOWLEDGEMENT)) {
      for (const reference of findReferences(marker, repo)) covered.add(key(reference));
    }
  }
  return covered;
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
  const skip = acknowledged(
    sources.map(({ text }) => text),
    repo,
  );
  const found: Citation[] = [];
  for (const { at, text } of sources) {
    for (const reference of findReferences(text, repo)) {
      if (skip.has(key(reference))) continue;
      skip.add(key(reference));
      found.push({ issue, reference, at });
    }
  }
  return found;
}

export function formatCitation({ issue, reference, at }: Citation, upstream: Upstream): string {
  return `#${issue.number} cites ${reference.repo}#${reference.number}, closed (${upstream.html_url}); cited in ${at}`;
}

/**
 * The lines to print for each open issue's citation of a closed upstream issue or pull request,
 * and for each citation `lookup` can't read. An acknowledged citation is in neither.
 */
export function closedCitations(
  issues: Issue[],
  lookup: Lookup = memoized(lookupUpstream),
): { closed: string[]; unreadable: string[] } {
  const closed: string[] = [];
  const unreadable: string[] = [];
  for (const issue of issues.filter((candidate) => candidate.pull_request === undefined)) {
    for (const citation of citations(issue)) {
      const upstream = lookup(citation.reference);
      if ("unreadable" in upstream) {
        unreadable.push(
          `#${issue.number} cites ${citation.reference.repo}#${citation.reference.number}, which GitHub does not return (${upstream.unreadable})`,
        );
      } else if (upstream.state === "closed") closed.push(formatCitation(citation, upstream));
    }
  }
  return { closed, unreadable };
}

const ACK_HINT =
  "To keep a deliberate citation, add `<!-- smonn-db:upstream-ack owner/repo#n -->` to the issue or a comment.";

function writeSummary(unreadable: string[], env: NodeJS.ProcessEnv): void {
  const { GITHUB_STEP_SUMMARY: path } = env;
  if (path === undefined || path === "" || unreadable.length === 0) return;
  const lines = ["## Closed upstream references", "", "GitHub did not return:", ""];
  appendFileSync(path, [...lines, ...unreadable.map((line) => `- ${line}`), ""].join("\n"));
}

function reportClosed(closed: string[]): void {
  if (closed.length === 0) {
    console.log("No open issue cites a closed upstream issue.");
    return;
  }
  console.log(closed.join("\n"));
  console.error(ACK_HINT);
  process.exitCode = 1;
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const issues = getAll("repos/{owner}/{repo}/issues?state=open&per_page=100", readIssue);
    const { closed, unreadable } = closedCitations(issues);
    for (const line of unreadable) console.warn(`warning: ${line}`);
    writeSummary(unreadable, env);
    reportClosed(closed);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
