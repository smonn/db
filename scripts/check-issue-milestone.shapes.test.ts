import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, needsCapitalTitle } from "./check-issue-milestone.ts";
import { event } from "./check-issue-milestone.test-helper.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn<typeof execFileSync>() }));

let dir: string;
const write = (payload: unknown): string => {
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-issue-milestone-shapes-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("needsCapitalTitle actions", () => {
  const issue = { title: "lowercase" };

  test("checks a title only on opened and on an edit that changed it", () => {
    expect(needsCapitalTitle(event(issue, { action: "labeled", changes: { title: {} } }))).toBe(
      false,
    );
    expect(needsCapitalTitle(event(issue, { action: "edited" }))).toBe(false);
  });
});

describe("main", () => {
  test("names the repository when its fields have the wrong shape", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const bad = { ...event(), repository: { full_name: "smonn/db", html_url: 5 } };
    expect(() => {
      main({ GITHUB_EVENT_PATH: write(bad) }, gh);
    }).toThrow("$.repository.html_url: expected string, got number");
    expect(gh).not.toHaveBeenCalled();
  });

  test("comments on an issue that has labels but not needs-triage", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ labels: [{ name: "bug" }] })) }, gh);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh).toHaveBeenNthCalledWith(1, expect.arrayContaining(["comment"]));
  });

  test("runs gh with its output passed through", () => {
    main({ GITHUB_EVENT_PATH: write(event()) });
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenLastCalledWith(
      "gh",
      ["issue", "edit", "7", "--repo", "smonn/db", "--add-label", "needs-triage"],
      { stdio: "inherit" },
    );
  });
});
