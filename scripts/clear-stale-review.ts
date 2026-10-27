/**
 * Clears a stale approval. When `review:needed` is added to a pull request, removes every other
 * `review:*` label, so a `review:approved` or `review:blocked` from an earlier head can't survive
 * a new request for review. AGENTS.md has agents add only `review:needed`, so this is the one
 * place that clears the others.
 *
 * Run with `GITHUB_EVENT_PATH` set to a `pull_request_target` event payload and `gh` authenticated,
 * as `pnpm clear:review`; the Clear stale review workflow runs it on `labeled`.
 */
import { execFileSync } from "node:child_process";
import {
  array,
  field,
  number,
  readEventPayload,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export type PullRequestEvent = {
  action: string;
  label?: { name: string };
  pull_request: { number: number; labels: { name: string }[] };
  repository: { full_name: string };
};

const NEEDED = "review:needed";

const readName: Reader<{ name: string }> = (value, path) => ({
  name: field(record(value, path), "name", string, path),
});

const readEvent: Reader<PullRequestEvent> = (value, path) => {
  const event = record(value, path);
  const prPath = `${path}.pull_request`;
  const pr = field(event, "pull_request", record, path);
  const repoPath = `${path}.repository`;
  const repository = field(event, "repository", record, path);
  const label = event["label"];
  return {
    action: field(event, "action", string, path),
    ...(label === undefined ? {} : { label: readName(label, `${path}.label`) }),
    pull_request: {
      number: field(pr, "number", number, prPath),
      labels: field(pr, "labels", array(readName), prPath),
    },
    repository: { full_name: field(repository, "full_name", string, repoPath) },
  };
};

type Gh = (args: string[]) => void;

export function staleReviewLabels({ action, label, pull_request: pr }: PullRequestEvent): string[] {
  if (action !== "labeled" || label?.name !== NEEDED) return [];
  return pr.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith("review:") && name !== NEEDED);
}

const runGh: Gh = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const payload = readEventPayload(env);
  if (payload === undefined) return;
  const event = readEvent(payload, "$");
  const stale = staleReviewLabels(event);
  if (stale.length === 0) return;
  gh([
    "pr",
    "edit",
    String(event.pull_request.number),
    "--repo",
    event.repository.full_name,
    ...stale.flatMap((name) => ["--remove-label", name]),
  ]);
}

if (import.meta.main) main();
