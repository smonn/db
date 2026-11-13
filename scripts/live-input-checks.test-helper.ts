import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { IssueSample, MergedPr, Source } from "./live-input-source.ts";

export function issue(number: number, overrides: Record<string, unknown> = {}): IssueSample {
  const raw = {
    number,
    title: `Issue ${number}`,
    state: "open",
    milestone: null,
    labels: [],
    user: { type: "User" },
    ...overrides,
  };
  return { number, title: `Issue ${number}`, raw };
}

export function mergedPr(number: number, overrides: Partial<MergedPr> = {}): MergedPr {
  return {
    number,
    title: "chore(tooling): tidy",
    body: "",
    branch: "chore/tidy",
    mergedAt: "2026-11-01T00:00:00Z",
    oid: "a".repeat(40),
    ...overrides,
  };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `Source` over canned samples; `gh` records every call and answers from `answers` by path. */
export function fakeSource(
  parts: Partial<Source> & { answers?: Record<string, string> } = {},
): Source & { calls: string[][]; closed: boolean } {
  const calls: string[][] = [];
  const { answers = {}, ...rest } = parts;
  const source = {
    repo: "owner/repo",
    gh: (args: string[]) => {
      calls.push(args);
      const answer = answers[args.at(-1) ?? ""];
      if (answer === undefined) throw new Error(`unexpected gh ${args.join(" ")}`);
      return answer;
    },
    issues: () => [],
    mergedPrs: () => [],
    branches: () => [],
    checkoutAt: () => "/nonexistent",
    scratch: () => {
      const dir = mkdtempSync(join(tmpdir(), "live-input-test-"));
      dirs.push(dir);
      return dir;
    },
    close: () => {
      source.closed = true;
    },
    calls,
    closed: false,
    ...rest,
  };
  return source;
}
