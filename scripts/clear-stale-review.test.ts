import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, type PullRequestEvent, staleReviewLabels } from "./clear-stale-review.ts";

function event(labels: string[], rest: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: "labeled",
    label: { name: "review:needed" },
    pull_request: { number: 9, labels: labels.map((name) => ({ name })) },
    repository: { full_name: "smonn/db" },
    ...rest,
  };
}

describe("staleReviewLabels", () => {
  test("lists every other review label when review:needed is added", () => {
    const labels = ["review:needed", "review:approved", "review:blocked", "area:tooling"];
    expect(staleReviewLabels(event(labels))).toEqual(["review:approved", "review:blocked"]);
  });

  test("lists nothing when review:needed is the only review label", () => {
    expect(staleReviewLabels(event(["review:needed", "area:tooling"]))).toEqual([]);
  });

  test("ignores a different label being added", () => {
    const added = event(["review:needed", "review:approved"], {
      label: { name: "review:approved" },
    });
    expect(staleReviewLabels(added)).toEqual([]);
  });

  test("ignores an action other than labeled", () => {
    expect(staleReviewLabels(event(["review:approved"], { action: "opened" }))).toEqual([]);
    const { label: _label, ...noLabel } = event(["review:approved"]);
    expect(staleReviewLabels(noLabel)).toEqual([]);
  });
});

describe("main", () => {
  let dir: string;
  const write = (payload: unknown): string => {
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify(payload));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clear-stale-review-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("removes the stale labels in one call", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event(["review:needed", "review:approved"])) }, gh);
    expect(gh.mock.calls).toEqual([
      [["pr", "edit", "9", "--repo", "smonn/db", "--remove-label", "review:approved"]],
    ]);
  });

  test("calls nothing when no label is stale", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event(["review:needed"])) }, gh);
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails without GITHUB_EVENT_PATH", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({}, gh);
    expect(process.exitCode).toBe(1);
    expect(gh).not.toHaveBeenCalled();
  });

  test("names the bad field in a malformed payload", () => {
    const path = write({ action: "labeled", pull_request: { number: "9" }, repository: {} });
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, vi.fn<(args: string[]) => void>());
    }).toThrow("$.pull_request.number");
  });
});
