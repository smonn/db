import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { QUOTED_KEYWORDS } from "./keywords.ts";

const db = useTestDatabase();

describe("QUOTED_KEYWORDS", () => {
  it("lists the keywords the tested Postgres quotes", async () => {
    const { rows } = await db.driver.query(
      "select word from pg_get_keywords() where catcode <> 'U' order by word",
    );

    expect([...QUOTED_KEYWORDS]).toStrictEqual(rows.map((row) => row["word"]));
  });
});
