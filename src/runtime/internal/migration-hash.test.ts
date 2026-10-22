import { describe, expect, it } from "vitest";
import { migrationHash } from "./migration-hash.ts";

describe("migrationHash", () => {
  it("hashes a newline and the body when there is no previous file", async () => {
    expect(await migrationHash(undefined, "create table a (n int);\n")).toBe(
      "sha256:d7d725aa0112fb1cbd6f88755f17784646fcd5154e0ea687f488c87fa1499173",
    );
  });

  it("hashes the previous hash, a newline, and the body", async () => {
    expect(await migrationHash(`sha256:${"a".repeat(64)}`, "create table b (n int);\n")).toBe(
      "sha256:da769c6fe78ea3f7868d6e624c7e405f7f1035605c4d54d2f9057a81f2e07764",
    );
  });
});
