import { describe, expect, it } from "vitest";
import { matchingPrefix } from "./recorded-prefix.ts";

const chain = [{ hash: "sha256:a" }, { hash: "sha256:b" }];
const rows = (...hashes: string[]) => hashes.map((hash) => ({ hash }));

describe("matchingPrefix", () => {
  it.each([
    [2, rows("sha256:a", "sha256:b")],
    [1, rows("sha256:a")],
    [0, rows()],
    [0, rows("sha256:b")],
    [1, rows("sha256:a", "sha256:other")],
  ] as const)("counts %i for %j", (expected, recorded) => {
    expect(matchingPrefix(recorded, chain)).toBe(expected);
  });

  it("stops at a row past the end of the chain", () => {
    expect(matchingPrefix(rows("sha256:a", "sha256:b", "sha256:c"), chain)).toBe(2);
  });
});
