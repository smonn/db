import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { INDEX_METHODS, METHOD_CAPABILITIES } from "./index-options.ts";

const db = useTestDatabase();

describe("METHOD_CAPABILITIES", () => {
  it.each(INDEX_METHODS)("matches what Postgres reports for %s", async (method) => {
    const { rows } = await db.driver.query(
      `select
         pg_indexam_has_property(oid, 'can_order') as "order",
         pg_indexam_has_property(oid, 'can_include') as "include",
         pg_indexam_has_property(oid, 'can_unique') as "unique",
         pg_indexam_has_property(oid, 'can_multi_col') as "multiColumn"
       from pg_am where amname = $1 and amtype = 'i'`,
      [method],
    );
    expect(rows).toStrictEqual([METHOD_CAPABILITIES[method]]);
  });
});
