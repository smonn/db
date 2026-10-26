import { describe, expect, test } from "vitest";
import { hookCwd, planSync, shouldSync } from "./session-start.ts";

describe("planSync", () => {
  test("does nothing when the branch is not behind", () => {
    expect(planSync({ behind: 0, ahead: 2, dirty: true })).toEqual({ kind: "up-to-date" });
  });

  test("fast-forwards a clean branch with no commits of its own", () => {
    expect(planSync({ behind: 3, ahead: 0, dirty: false })).toEqual({
      kind: "fast-forward",
      behind: 3,
    });
  });

  test("reports instead of fast-forwarding a branch with its own commits", () => {
    expect(planSync({ behind: 1, ahead: 2, dirty: false })).toEqual({
      kind: "report",
      message:
        "This branch is 1 commit behind origin/main and has 2 commits of its own, so it was not fast-forwarded. Branch new work from origin/main.",
    });
  });

  test("reports instead of fast-forwarding a branch with uncommitted changes", () => {
    expect(planSync({ behind: 2, ahead: 1, dirty: true })).toEqual({
      kind: "report",
      message:
        "This branch is 2 commits behind origin/main and has 1 commit of its own and uncommitted changes, so it was not fast-forwarded. Branch new work from origin/main.",
    });
  });
});

describe("shouldSync", () => {
  const subagent = '{"hook_event_name":"SubagentStart"}';

  test("skips a subagent that works in the project checkout", () => {
    expect(shouldSync(subagent, "/proj", "/proj/")).toBe(false);
  });

  test("syncs a subagent in another directory", () => {
    expect(shouldSync(subagent, "/proj/.claude/worktrees/a", "/proj")).toBe(true);
  });

  test("syncs a subagent when the project directory is unknown", () => {
    expect(shouldSync(subagent, "/proj")).toBe(true);
  });

  test.each(['{"hook_event_name":"SessionStart"}', "", "not json"])(
    "syncs a session start in the project checkout for %j",
    (input) => {
      expect(shouldSync(input, "/proj", "/proj")).toBe(true);
    },
  );
});

describe("hookCwd", () => {
  test("uses the cwd the hook input names", () => {
    expect(hookCwd('{"cwd":"/work/tree","hook_event_name":"SubagentStart"}', "/fallback")).toBe(
      "/work/tree",
    );
  });

  test.each(["", "not json", "{}", '{"cwd":""}', '{"cwd":3}', "null"])(
    "falls back for %j",
    (input) => {
      expect(hookCwd(input, "/fallback")).toBe("/fallback");
    },
  );
});
