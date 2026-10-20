/**
 * Claude Code SessionStart hook: brings a new session's branch up to date with `origin/main`,
 * then installs dependencies. It fast-forwards only a clean branch with no commits of its own,
 * and otherwise reports how far behind the branch is. What it prints on stdout lands in the
 * agent's context.
 *
 * `.claude/settings.json` runs it on startup; run it by hand with `node scripts/session-start.ts`.
 */
import { spawnSync } from "node:child_process";

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

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function count(range: string): number {
  return Number(run("git", ["rev-list", "--count", range]).out);
}

function syncWithMain(): void {
  if (!run("git", ["fetch", "--quiet", "origin", "main"]).ok) {
    console.log("Could not fetch origin/main; the branch may be behind it.");
    return;
  }
  const plan = planSync({
    behind: count("HEAD..origin/main"),
    ahead: count("origin/main..HEAD"),
    dirty: run("git", ["status", "--porcelain"]).out !== "",
  });
  if (plan.kind === "report") console.log(plan.message);
  if (plan.kind === "fast-forward") {
    const merge = run("git", ["merge", "--ff-only", "--quiet", "origin/main"]);
    console.log(
      merge.ok
        ? `Fast-forwarded this branch by ${commits(plan.behind)} to origin/main.`
        : `Fast-forward to origin/main failed:\n${merge.out}`,
    );
  }
}

function main(): void {
  syncWithMain();
  const install = run("pnpm", ["install", "--frozen-lockfile"]);
  if (!install.ok)
    console.log(`pnpm install failed:\n${install.out.split("\n").slice(-10).join("\n")}`);
}

if (import.meta.main) main();
