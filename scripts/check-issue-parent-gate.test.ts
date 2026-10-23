import { describe, expect, test } from "vitest";
import { needsParentCheck } from "./check-issue-parent.ts";
import { event, labelled } from "./check-issue-parent.test-helper.ts";

describe("needsParentCheck", () => {
  test("accepts an open issue with a milestone and an area label on each trigger", () => {
    for (const action of ["opened", "labeled", "milestoned"]) {
      expect(needsParentCheck(event({}, { action }))).toBe(true);
    }
  });

  test("ignores other actions", () => {
    for (const action of ["edited", "demilestoned", "closed", "unlabeled"]) {
      expect(needsParentCheck(event({}, { action }))).toBe(false);
    }
  });

  test("skips a closed issue, a bot issue, and an issue without a milestone", () => {
    expect(needsParentCheck(event({ state: "closed" }))).toBe(false);
    expect(needsParentCheck(event({ user: { type: "Bot" } }))).toBe(false);
    expect(needsParentCheck(event({ milestone: null }))).toBe(false);
  });

  test("skips an issue without an area label", () => {
    expect(needsParentCheck(event({ labels: labelled("bug") }))).toBe(false);
    expect(needsParentCheck(event({ labels: [] }))).toBe(false);
  });

  test("skips a wayfinder map", () => {
    const labels = labelled("area:tooling", "wayfinder:map");
    expect(needsParentCheck(event({ labels }))).toBe(false);
  });
});
