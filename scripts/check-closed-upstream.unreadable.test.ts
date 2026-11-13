import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { main } from "./check-closed-upstream.ts";
import {
  ghReplies,
  notFound,
  openIssues,
  quietMain,
  recordedReplies,
  synthetic,
  upstreamPath,
} from "./check-closed-upstream.test-helper.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const spawn = vi.mocked(spawnSync);
const postgres1219 = upstreamPath("porsager/postgres", 1219);
const postgres1240 = upstreamPath("porsager/postgres", 1240);
const summaryFile = () => join(mkdtempSync(join(tmpdir(), "closed-upstream-")), "summary.md");

describe("main with a reference GitHub does not return", () => {
  quietMain(spawn);

  test.each([
    [403, "gh: Resource not accessible (HTTP 403)"],
    [410, "gh: This issue was deleted (HTTP 410)"],
  ])("warns about a %i, and does not fail on it", (status, stderr) => {
    ghReplies(spawn, { ...recordedReplies(), [postgres1219]: { status: 1, stderr } });
    main();
    expect(console.warn).toHaveBeenCalledWith(
      `warning: #614 cites porsager/postgres#1219, which GitHub does not return (${status})`,
    );
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("failed"));
  });

  test("still fails on a 403 that names a rate limit, however GitHub words it", () => {
    const stderr = "gh: You have exceeded a Secondary Rate Limit (HTTP 403)";
    ghReplies(spawn, { ...recordedReplies(), [postgres1240]: { status: 1, stderr } });
    main();
    expect(console.warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test.each(["gh: Server Error (HTTP 500)", "gh: connection refused"])(
    "fails on an error with a status it does not tolerate, or none: %s",
    (stderr) => {
      ghReplies(spawn, { ...recordedReplies(), [postgres1240]: { status: 1, stderr } });
      main();
      expect(console.error).toHaveBeenLastCalledWith(`gh api ${postgres1240} failed:\n${stderr}`);
      expect(process.exitCode).toBe(1);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  test("writes them to the step summary", () => {
    ghReplies(spawn, {
      ...recordedReplies(),
      [postgres1219]: notFound,
      [upstreamPath("porsager/postgres", 1220)]: { status: 1, stderr: "gh: Gone (HTTP 410)" },
    });
    const summary = summaryFile();
    main({ GITHUB_STEP_SUMMARY: summary });
    expect(readFileSync(summary, "utf8")).toBe(
      [
        "## Closed upstream references",
        "",
        "GitHub did not return:",
        "",
        "- #614 cites porsager/postgres#1219, which GitHub does not return (404)",
        "- #614 cites porsager/postgres#1220, which GitHub does not return (410)",
        "",
      ].join("\n"),
    );
  });

  test("writes no step summary when every reference was readable", () => {
    ghReplies(spawn, recordedReplies());
    const summary = summaryFile();
    main({ GITHUB_STEP_SUMMARY: summary });
    expect(() => readFileSync(summary, "utf8")).toThrow(/ENOENT/u);
  });

  test.each([{}, { GITHUB_STEP_SUMMARY: "" }])("writes no step summary for the env %j", (env) => {
    ghReplies(spawn, {
      [openIssues]: JSON.stringify([[synthetic({ body: "pnpm/pnpm#9" })]]),
      [upstreamPath("pnpm/pnpm", 9)]: notFound,
    });
    main(env);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("main failing on a closed citation", () => {
  quietMain(spawn);

  test("tells how to acknowledge a citation", () => {
    ghReplies(spawn, recordedReplies());
    main();
    expect(console.error).toHaveBeenCalledWith(
      "To keep a deliberate citation, add `<!-- smonn-db:upstream-ack owner/repo#n -->` to the issue or a comment.",
    );
  });

  test("tells nothing when no citation is closed", () => {
    ghReplies(spawn, { [openIssues]: JSON.stringify([[synthetic({})]]) });
    main();
    expect(console.error).not.toHaveBeenCalled();
  });
});
