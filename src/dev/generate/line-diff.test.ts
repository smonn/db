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

  it("handles a removal at the end and an addition at the start", () => {
    expect(lineDiff("a\nb\n", "a\n")).toBe("-b\n");
    expect(lineDiff("a\n", "x\na\n")).toBe("+x\n");
  });

  it("is all additions from empty text and all removals to it", () => {
    expect(lineDiff("", "a\nb\n")).toBe("+a\n+b\n");
    expect(lineDiff("a\nb\n", "")).toBe("-a\n-b\n");
  });

  it("removes before it adds when both orders keep as many lines", () => {
    expect(lineDiff("x\na\n", "b\na\n")).toBe("-x\n+b\n");
  });

  it("adds the lines before a shared one rather than dropping it", () => {
    expect(lineDiff("a\n", "b\nb\na\n")).toBe("+b\n+b\n");
  });

  it("keeps the longest run of shared lines", () => {
    expect(lineDiff("a\nb\nc\nd\ne\n", "b\nx\nd\ny\ne\n")).toBe("-a\n-c\n+x\n+y\n");
  });
});
