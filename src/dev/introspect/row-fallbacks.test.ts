import { describe, expect, it } from "vitest";
import type { DriverRow, Queryable, Session } from "../../runtime/ports/index.ts";
import { introspect } from "./introspect.ts";
import { DOMAINS, ENUMS, FOREIGN_KEYS, SCHEMAS, TABLES } from "./queries.ts";

/** A session whose queries answer from `answers`, and with no rows otherwise. */
function sessionAnswering(answers: ReadonlyMap<string, readonly DriverRow[]>): Session {
  const tx: Queryable = {
    execute: () => Promise.resolve(),
    query: (sql) => {
      const rows = sql.includes("server_version_num")
        ? [{ server_version_num: "180000" }]
        : [...(answers.get(sql) ?? [])];
      return Promise.resolve({ rows, count: rows.length });
    },
  };
  return { ...tx, transaction: (fn) => fn(tx) };
}

describe("introspect, given rows the catalog queries never return", () => {
  it("reads an enum without a label list as an enum with no labels", async () => {
    const session = sessionAnswering(
      new Map([
        [SCHEMAS, [{ name: "app" }]],
        [ENUMS, [{ schema: "app", name: "mood", labels: null }]],
      ]),
    );

    const catalog = await introspect(session);

    expect(Object.fromEntries(catalog)["app\0mood"]).toMatchObject({
      kind: "enum",
      payload: { labels: [] },
    });
  });

  it("reads a domain row without a default expression as a domain with no default", async () => {
    const session = sessionAnswering(
      new Map([
        [SCHEMAS, [{ name: "app" }]],
        [DOMAINS, [{ schema: "app", name: "posint", base: "integer" }]],
      ]),
    );

    const catalog = await introspect(session);

    expect(Object.fromEntries(catalog)["app\0posint"]).toStrictEqual({
      kind: "domain",
      name: "posint",
      parent: "app",
      payload: { base: "integer", notNull: false, default: null, defaultVolatile: false },
    });
  });

  it("reads a foreign key with unknown action codes as NO ACTION, and without column lists as empty", async () => {
    const session = sessionAnswering(
      new Map([
        [SCHEMAS, [{ name: "app" }]],
        [TABLES, [{ schema: "app", name: "t" }]],
        [
          FOREIGN_KEYS,
          [
            {
              schema: "app",
              table: "t",
              name: "t_fk",
              columns: null,
              target_schema: "app",
              target_table: "t",
              target_columns: null,
              on_delete: "?",
              on_update: "?",
              match: "s",
              deferrable: false,
            },
          ],
        ],
      ]),
    );

    const catalog = await introspect(session);

    expect([...catalog.values()].find((fact) => fact.kind === "foreign key")).toMatchObject({
      name: "t_fk",
      payload: {
        columns: [],
        target: { schema: "app", table: "t", columns: [] },
        onDelete: "no action",
        onUpdate: "no action",
      },
    });
  });
});
