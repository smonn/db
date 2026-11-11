import { describe, expect, it } from "vitest";
import { compareRecorded } from "./recorded-chain.ts";

const chain = [{ hash: "sha256:a" }, { hash: "sha256:b" }];
const rows = (...hashes: string[]) => hashes.map((hash) => ({ hash }));

describe("compareRecorded", () => {
  it.each([
    ["match", rows("sha256:a", "sha256:b")],
    ["behind", rows("sha256:a")],
    ["behind", rows()],
    ["diverged", rows("sha256:b")],
    ["diverged", rows("sha256:other", "sha256:b")],
    ["diverged", rows("sha256:a", "sha256:b", "sha256:c")],
  ] as const)("reads %s for %j", (expected, recorded) => {
    expect(compareRecorded(recorded, chain)).toBe(expected);
  });
});
