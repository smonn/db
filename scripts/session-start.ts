/**
 * Claude Code SessionStart hook: brings a new session's branch up to date with `origin/main`,
 * then installs dependencies. It fast-forwards only a clean branch with no commits of its own,
 * and otherwise reports how far behind the branch is. What it prints on stdout lands in the
 * agent's context.
 *
 * `.claude/settings.json` runs it on session startup and when a subagent starts. Both events pass
 * a JSON object on stdin whose `cwd` is the directory the session or subagent works in, while
 * `$CLAUDE_PROJECT_DIR` stays at the project root. So the script installs into that `cwd`, which
 * is the worktree for a worktree-isolated subagent. Run it by hand with
 * `node scripts/session-start.ts`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type BranchState = { behind: number; ahead: number; dirty: boolean };

type SyncPlan =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; behind: number }
  | { kind: "report"; message: string };

function commits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

export function planSync({ behind, ahead, dirty }: BranchState): SyncPlan {
  if (behind === 0) return { kind: "up-to-date" };
  if (ahead === 0 && !dirty) return { kind: "fast-forward", behind };
  const own = [ahead > 0 ? `${commits(ahead)} of its own` : "", dirty ? "uncommitted changes" : ""]
    .filter(Boolean)
    .join(" and ");
  return {
    kind: "report",
    message: `This branch is ${commits(behind)} behind origin/main and has ${own}, so it was not fast-forwarded. Branch new work from origin/main.`,
  };
}

function run(cwd: string, command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8", cwd });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function count(cwd: string, range: string): number {
  return Number(run(cwd, "git", ["rev-list", "--count", range]).out);
}

function syncWithMain(cwd: string): void {
  if (!run(cwd, "git", ["fetch", "--quiet", "origin", "main"]).ok) {
    console.log("Could not fetch origin/main; the branch may be behind it.");
    return;
  }
  const plan = planSync({
    behind: count(cwd, "HEAD..origin/main"),
    ahead: count(cwd, "origin/main..HEAD"),
    dirty: run(cwd, "git", ["status", "--porcelain"]).out !== "",
  });
  if (plan.kind === "report") console.log(plan.message);
  if (plan.kind === "fast-forward") {
    const merge = run(cwd, "git", ["merge", "--ff-only", "--quiet", "origin/main"]);
    console.log(
      merge.ok
        ? `Fast-forwarded this branch by ${commits(plan.behind)} to origin/main.`
        : `Fast-forward to origin/main failed:\n${merge.out}`,
    );
  }
}

function hookField(input: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value: unknown = Object.entries(parsed).find(([key]) => key === field)?.[1];
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function hookCwd(input: string, fallback: string): string {
  return hookField(input, "cwd") ?? fallback;
}

// A subagent without worktree isolation works in the parent's own checkout, which the running
// session owns: fetching or fast-forwarding there would change files under it.
export function shouldSync(input: string, cwd: string, projectDir?: string): boolean {
  if (hookField(input, "hook_event_name") !== "SubagentStart") return true;
  return projectDir === undefined || resolve(cwd) !== resolve(projectDir);
}

function readStdin(): string {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function main(cwd: string = process.cwd(), sync = true): void {
  if (sync) syncWithMain(cwd);
  const install = run(cwd, "pnpm", ["install", "--frozen-lockfile"]);
  if (!install.ok)
    console.log(`pnpm install failed:\n${install.out.split("\n").slice(-10).join("\n")}`);
}

if (import.meta.main) {
  const input = readStdin();
  const cwd = hookCwd(input, process.cwd());
  main(cwd, shouldSync(input, cwd, process.env["CLAUDE_PROJECT_DIR"]));
}
