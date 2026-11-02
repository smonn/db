import { describe, expect, it } from "vitest";
import { aliasFor } from "./alias.ts";

describe("aliasFor", () => {
  it("keeps a name no earlier table uses", () => {
    expect(aliasFor("users", new Set(["posts"]))).toBe("users");
  });

  it("adds the first free suffix from _2", () => {
    expect(aliasFor("users", new Set(["users"]))).toBe("users_2");
    expect(aliasFor("users", new Set(["users", "users_2", "users_3"]))).toBe("users_4");
    expect(aliasFor("users", new Set(["users", "users_3"]))).toBe("users_2");
  });

  it("cuts the name so name plus suffix fits in 63 bytes", () => {
    const long = "t".repeat(63);
    expect(aliasFor(long, new Set([long]))).toBe(`${"t".repeat(61)}_2`);
    const tenth = new Set([long, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${"t".repeat(61)}_${n}`)]);
    expect(aliasFor(long, tenth)).toBe(`${"t".repeat(60)}_10`);
  });

  it("cuts between characters, never inside one", () => {
    const name = `${"t".repeat(60)}é`;
    expect(new TextEncoder().encode(name).length).toBe(62);
    expect(aliasFor(name, new Set([name]))).toBe(`${"t".repeat(60)}_2`);
  });
});
