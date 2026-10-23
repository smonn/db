import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./catalog.ts";

const pkeyCatalog = (table: string) =>
  definitionCatalog(
    defineDatabase({
      public: { [table]: defineTable((c) => ({ id: c.text().primaryKey() })) },
    }),
  );

describe("a constraint name", () => {
  it("is refused when Postgres would truncate it", () => {
    expect(() => pkeyCatalog("t".repeat(60))).toThrow("is longer than 63 bytes");
  });

  it("is kept at exactly 63 bytes and refused at 64", () => {
    const name = `${"t".repeat(58)}_pkey`;
    expect(name).toHaveLength(63);
    expect([...pkeyCatalog("t".repeat(58)).keys()]).toContain(
      `public\0${"t".repeat(58)}\0\0${name}`,
    );
    expect(() => pkeyCatalog("t".repeat(59))).toThrow("is longer than 63 bytes");
  });

  it("counts bytes, not characters", () => {
    expect(() => pkeyCatalog("é".repeat(29))).not.toThrow();
    expect(() => pkeyCatalog("é".repeat(30))).toThrow("is longer than 63 bytes");
  });
});
