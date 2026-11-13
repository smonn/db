import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { ChangedAdr } from "./check-pr.ts";
import { fakeSource, mergedPr } from "./live-input-checks.test-helper.ts";
import { runProbe } from "./live-input-probe.ts";
import { REPO_CHECKS, branchProbes, prProbes } from "./live-input-repo.ts";

afterEach(() => {
  process.exitCode = undefined;
});

const oidc = REPO_CHECKS.filter((check) => check.name === "check:oidc");

test("check:branch refuses a branch the rule rejects and passes the others", () => {
  const source = fakeSource({ branches: () => ["feature/ok", "Bad_Branch", "research/notes"] });
  expect(branchProbes(source).map((probe) => runProbe(probe).outcome)).toEqual([
    "passed",
    "refused",
    "passed",
  ]);
  expect(runProbe(branchProbes(source)[1]!).lines).toEqual([
    expect.stringContaining('Branch "Bad_Branch" is not a Conventional Branch'),
  ]);
});

test("check:pr checks each merged PR against its merge commit's first parent", () => {
  const oid = "b".repeat(40);
  const source = fakeSource({
    mergedPrs: () => [mergedPr(1, { oid }), mergedPr(2, { title: "tidy up", oid })],
    checkoutAt: (at) => `/checkout/${at.slice(0, 4)}`,
  });
  const adrs = vi.fn<() => ChangedAdr[]>(() => []);
  const files = vi.fn<() => string[]>(() => []);
  const run = prProbes(source, { adrs, files }).map((probe) => runProbe(probe));
  expect(run.map((result) => result.outcome)).toEqual(["passed", "refused"]);
  expect(run[1]?.lines).toEqual([
    expect.stringContaining('PR title "tidy up" is not a Conventional'),
  ]);
  expect(adrs).toHaveBeenCalledWith(`${oid}^1`, "/checkout/bbbb");
  expect(files).toHaveBeenCalledWith(`${oid}^1`, "/checkout/bbbb");
});

test("check:pr leaves the process exit code alone when it refuses a PR", () => {
  const source = fakeSource({ mergedPrs: () => [mergedPr(2, { title: "tidy up" })] });
  for (const probe of prProbes(source, { adrs: () => [], files: () => [] })) runProbe(probe);
  expect(process.exitCode).toBeUndefined();
});

test("check:pr throws when its git read does", () => {
  const source = fakeSource({ mergedPrs: () => [mergedPr(3)] });
  const failing = {
    adrs: () => {
      throw new Error("bad revision");
    },
    files: () => [],
  };
  expect(runProbe(prProbes(source, failing)[0]!)).toMatchObject({
    outcome: "threw",
    lines: ["bad revision"],
  });
});

test("check:oidc passes over this repository's workflows", () => {
  expect(
    oidc.flatMap((check) => check.probes(fakeSource())).map((probe) => runProbe(probe)),
  ).toMatchObject([{ outcome: "passed" }]);
});

// The checks run in-process, so none may write to GitHub except through the `gh` the runner hands
// the issue checks. These four have no such seam: they only read.
test.each(["check-pr", "check-branch", "check-oidc-jobs", "check-closed-upstream"])(
  "%s holds no gh write",
  (script) => {
    const text = readFileSync(`scripts/${script}.ts`, "utf8");
    expect(text).not.toMatch(
      /"(comment|edit|close|merge|create|review)"|"-X"|"--method"|"-[fF]"|DELETE|POST|PATCH/u,
    );
  },
);
