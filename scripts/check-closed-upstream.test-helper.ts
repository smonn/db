import { readFileSync } from "node:fs";
import type { SpawnSyncReturns, spawnSync } from "node:child_process";
import type { MockedFunction } from "vitest";

/** The text of a payload recorded from `gh api` on 2026-11-01, trimmed to the fields the check reads. */
export function recorded(name: string): string {
  return readFileSync(new URL(`./fixtures/closed-upstream/${name}.json`, import.meta.url), "utf8");
}

export type Reply = string | { status: number; stderr: string };

function result(reply: Reply): SpawnSyncReturns<string> {
  const base = { pid: 0, output: [], signal: null };
  if (typeof reply === "string") return { ...base, stdout: reply, stderr: "", status: 0 };
  return { ...base, stdout: "", stderr: reply.stderr, status: reply.status };
}

/**
 * Answers each `gh api` call to `spawn` from `replies`, keyed by the request path (the last
 * argument), and fails the rest with status 1 and no 404.
 */
export function ghReplies(
  spawn: MockedFunction<typeof spawnSync>,
  replies: Record<string, Reply>,
): void {
  spawn.mockImplementation((_command, args) => {
    const path = args?.at(-1) ?? "";
    const reply = replies[path];
    return result(reply ?? { status: 1, stderr: `no route ${path}` });
  });
}

export const notFound: Reply = { status: 1, stderr: "gh: Not Found (HTTP 404)" };

export const openIssues = "repos/{owner}/{repo}/issues?state=open&per_page=100";

export const commentsPath = (issue: number): string =>
  `repos/smonn/db/issues/${issue}/comments?per_page=100`;

export const upstreamPath = (repo: string, number: number): string =>
  `repos/${repo}/issues/${number}`;

/** Every route the recorded open issues need to run, with each upstream closed. */
export function recordedReplies(): Record<string, Reply> {
  const upstream = (number: number): [string, Reply] => [
    upstreamPath("porsager/postgres", number),
    recorded(`porsager-postgres-${number}`),
  ];
  return {
    [openIssues]: recorded("open-issues"),
    [commentsPath(364)]: recorded("comments-364"),
    [commentsPath(614)]: recorded("comments-614"),
    [commentsPath(696)]: recorded("comments-696"),
    ...Object.fromEntries([1240, 1199, 1219, 1220].map((number) => upstream(number))),
  };
}
