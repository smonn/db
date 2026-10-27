import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GRACE_MS, main } from "./check-issue-parent.ts";
import {
  comment,
  commentsRoute,
  event,
  issueRoute,
  milestonePath,
  orphan,
  parentIssue,
  writeEvent,
} from "./check-issue-parent.test-helper.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn<typeof execFileSync>() }));

const routes: Record<string, unknown> = {
  [issueRoute]: orphan,
  [commentsRoute]: [[]],
  [milestonePath]: [[parentIssue(44, "area:tooling")]],
};

describe("main with the default gh and wait", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs gh for UTF-8 output and sleeps the grace period before commenting", () => {
    vi.mocked(execFileSync).mockImplementation((_command, args) =>
      JSON.stringify(routes[String(args?.at(-1))]),
    );
    const sleep = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    main({ GITHUB_EVENT_PATH: writeEvent(event()) });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(expect.any(Int32Array), 0, 0, GRACE_MS);
    expect(execFileSync).toHaveBeenCalledWith("gh", ["api", issueRoute], { encoding: "utf8" });
    expect(execFileSync).toHaveBeenLastCalledWith("gh", comment("#44"), { encoding: "utf8" });
  });
});
