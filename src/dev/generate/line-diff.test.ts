import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff.ts";

describe("lineDiff", () => {
  it("is empty for equal text", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("marks lines only in the first text with - and only in the second with +", () => {
    expect(lineDiff("a\nb\nc\n", "a\nx\nc\n")).toBe("-b\n+x\n");
  });

  it("handles additions at the end and removals at the start", () => {
    expect(lineDiff("a\nb\n", "b\nc\n")).toBe("-a\n+c\n");
  });
});
