import { describe, expect, it } from "vitest";
import { parseMigration, trackingSchema, writeMigration } from "../internal/index.ts";
import type { Queryable, QueryResult } from "../ports/index.ts";
import { applyMigration } from "./apply.ts";

const MARKING = new Error("the connection is gone");

function failOnUpdate(text: string): Promise<QueryResult> {
  return text.startsWith("update")
    ? Promise.reject(MARKING)
    : Promise.resolve({ rows: [], count: 1 });
}

describe("applyMigration", () => {
  it("rejects with both errors when marking a failed no-transaction file fails too", async () => {
    const migration = parseMigration(
      await writeMigration("000001-a.sql", undefined, "create index concurrently i on t (c);", {
        noTransaction: true,
      }),
    );
    const statement = new Error("the statement failed");
    const session: Queryable = { execute: () => Promise.reject(statement), query: failOnUpdate };

    const failure = applyMigration(session, trackingSchema("smonn_db"), migration, () =>
      Promise.reject(new Error("a no-transaction file never opens a transaction")),
    );

    await expect(failure).rejects.toMatchObject({
      errors: [statement, MARKING],
      cause: MARKING,
    });
  });
});
