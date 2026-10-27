import { describe, expect, it } from "vitest";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";
import { ADD, DROP, FK, database } from "./foreign-keys.test-helper.ts";

describe("changing a foreign key", () => {
  it.each([
    ["an action", { onDelete: "cascade" }],
    ["the update action", { onUpdate: "restrict" }],
    ["MATCH", { match: "full" }],
    ["deferrable", { deferrable: "deferred" }],
    ["its columns", { columns: ["id"] }],
    ["its target", { target: { schema: "public", table: "orders", columns: ["id"] } }],
  ] as const)("drops and adds it back when %s changes", (_, change) => {
    const result = diff(
      database({ foreignKeys: { [FK]: {} } }),
      database({ foreignKeys: { [FK]: change } }),
    );

    expect(result.sql.split("\n\n")).toStrictEqual([
      DROP,
      expect.stringContaining(
        `-- hazard: share_row_exclusive_lock\n${ADD.split(" foreign key")[0]}`,
      ),
    ]);
  });

  it("renames one under a new name", () => {
    const sql = bareDiff(
      database({ foreignKeys: { old: {} } }),
      database({ foreignKeys: { fresh: {} } }),
    );

    expect(sql).toBe(`alter table "public"."orders" rename constraint "old" to "fresh";\n`);
  });

  it("emits nothing for an unchanged foreign key, whatever the payload's key order", () => {
    expect(
      diff(
        database({ foreignKeys: { [FK]: { onDelete: "cascade" } } }),
        database({ foreignKeys: { [FK]: { onDelete: "cascade" } } }),
      ).sql,
    ).toBe("");
  });
});
