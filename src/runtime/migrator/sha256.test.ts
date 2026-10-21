import { describe, expect, it } from "vitest";
import { sha256 } from "./sha256.ts";

describe("sha256", () => {
  it("returns the lowercase hex digest of UTF-8 text", async () => {
    expect(await sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("encodes non-ASCII text as UTF-8", async () => {
    expect(await sha256("å")).toBe(
      "e83979df9d36090142f23051f8e8d7ad48e5c20dff5c9e7b92ca3454f67469f9",
    );
  });
});
