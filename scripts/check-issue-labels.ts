/**
 * Checks an `issues` event for a ready issue that breaks the label rule in
 * `docs/agents/triage-labels.md`: exactly one `priority:*` label and exactly one category label
 * (`bug` or `enhancement`) on every `ready-for-agent` or `ready-for-human` issue. When an open,
 * human-opened ready issue lacks either, it gets one comment naming the gap. The comment carries
 * a marker, and an issue that already has one gets no second comment.
 *
 * Run with `GITHUB_EVENT_PATH` set to an `issues` event payload and `gh` authenticated, as
 * `pnpm check:labels`; the Issue milestone workflow runs it on `labeled` and `unlabeled` for the
 * ready, priority, and category labels. The event decides whether to check; the REST API supplies
 * the labels, since a concurrent label edit may have changed them since the event fired.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { array, field, number, parseJson, record, string, type Reader } from "./github-json.ts";

export const MARKER = "<!-- smonn-db:ready-labels -->";

const CHECKED_ACTIONS = new Set(["labeled", "unlabeled"]);
const READY_LABELS = new Set(["ready-for-agent", "ready-for-human"]);
const CATEGORY_LABELS = new Set(["bug", "enhancement"]);

export type LabelledIssue = {
  number: number;
  state: string;
  labels: { name: string }[];
  user: { type: string };
};

export type LabelsEvent = {
  action: string;
  issue: LabelledIssue;
  repository: { full_name: string };
};

const readName: Reader<{ name: string }> = (value, path) => ({
  name: field(record(value, path), "name", string, path),
});

export const readIssue: Reader<LabelledIssue> = (value, path) => {
  const fields = record(value, path);
  return {
    number: field(fields, "number", number, path),
    state: field(fields, "state", string, path),
    labels: field(fields, "labels", array(readName), path),
    user: field(
      fields,
      "user",
      (user, p) => ({ type: field(record(user, p), "type", string, p) }),
      path,
    ),
  };
};

const readEvent: Reader<LabelsEvent> = (value, path) => {
  const event = record(value, path);
  const repository = field(event, "repository", record, path);
  return {
    action: field(event, "action", string, path),
    issue: field(event, "issue", readIssue, path),
    repository: {
      full_name: field(repository, "full_name", string, `${path}.repository`),
    },
  };
};

const readComment: Reader<{ body: string }> = (value, path) => ({
  body: field(record(value, path), "body", string, path),
});

/** Runs `gh` with `args` and returns its standard output. */
type Gh = (args: string[]) => string;

const runGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

function names(issue: LabelledIssue): string[] {
  return issue.labels.map((label) => label.name);
}

/** Whether the issue is open, human-opened, and carries a ready label. */
function qualifies(issue: LabelledIssue): boolean {
  return (
    issue.state === "open" &&
    issue.user.type !== "Bot" &&
    names(issue).some((n) => READY_LABELS.has(n))
  );
}

/** A cheap pre-filter on the event; `main` re-checks the issue it fetches. */
export function needsLabelCheck(event: LabelsEvent): boolean {
  return CHECKED_ACTIONS.has(event.action) && qualifies(event.issue);
}

function gap(noun: string, found: string[]): string | undefined {
  if (found.length === 1) return undefined;
  if (found.length === 0) return `no ${noun}`;
  return `${found.length} ${noun}s (${found.map((label) => `\`${label}\``).join(", ")})`;
}

/** What the issue's labels lack or double up on, one phrase per problem; empty when it complies. */
export function labelGaps(issue: LabelledIssue): string[] {
  const all = names(issue);
  return [
    gap(
      "`priority:*` label",
      all.filter((n) => n.startsWith("priority:")),
    ),
    gap(
      "category label",
      all.filter((n) => CATEGORY_LABELS.has(n)),
    ),
  ].filter((phrase) => phrase !== undefined);
}

function alreadyCommented(issuePath: string, gh: Gh): boolean {
  const commentsPath = `${issuePath}/comments?per_page=100`;
  const pages = parseJson(
    gh(["api", "--paginate", "--slurp", commentsPath]),
    `gh api ${commentsPath}`,
  );
  return array(array(readComment))(pages, "$")
    .flat()
    .some((comment) => comment.body.includes(MARKER));
}

function readyGaps(issue: LabelledIssue): string[] {
  return qualifies(issue) ? labelGaps(issue) : [];
}

/** The event to check, or `undefined` when the variable is unset or the event needs no check. */
function readEnvEvent(env: NodeJS.ProcessEnv): LabelsEvent | undefined {
  const { GITHUB_EVENT_PATH: eventPath } = env;
  if (eventPath === undefined) {
    console.error("Set GITHUB_EVENT_PATH");
    process.exitCode = 1;
    return undefined;
  }
  const event = readEvent(parseJson(readFileSync(eventPath, "utf8"), eventPath), "$");
  return needsLabelCheck(event) ? event : undefined;
}

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const event = readEnvEvent(env);
  if (event === undefined) return;
  const { repository } = event;
  const issuePath = `repos/${repository.full_name}/issues/${event.issue.number}`;
  const current = readIssue(parseJson(gh(["api", issuePath]), `gh api ${issuePath}`), "$");
  const gaps = readyGaps(current);
  if (gaps.length === 0 || alreadyCommented(issuePath, gh)) return;
  const body = `${MARKER}\nThis ready issue breaks the label rule in \`docs/agents/triage-labels.md\`: ${gaps.join(" and ")}. Give it exactly one \`priority:*\` label and exactly one of \`bug\` or \`enhancement\`.`;
  gh(["issue", "comment", String(current.number), "--repo", repository.full_name, "--body", body]);
}

if (import.meta.main) main();
