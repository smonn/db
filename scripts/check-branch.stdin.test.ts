import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-branch.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>() };
});

const zeros = "0".repeat(40);
const pushed = `a ${"b".repeat(40)} refs/heads/docs/z ${zeros}\n`;

describe("main stdin", () => {
  const isTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdin.isTTY = isTTY;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("reads git's pre-push lines from standard input", () => {
    process.stdin.isTTY = false;
    vi.mocked(readFileSync).mockReturnValueOnce(pushed);
    main();
    expect(readFileSync).toHaveBeenCalledWith(0, "utf8");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  test("reads nothing from a terminal", () => {
    process.stdin.isTTY = true;
    vi.mocked(readFileSync).mockClear();
    main();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
