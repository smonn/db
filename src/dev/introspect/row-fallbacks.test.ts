import { describe, expect, it } from "vitest";
import type { DriverRow, Queryable, Session } from "../../runtime/ports/index.ts";
import { introspect } from "./introspect.ts";
import { expression, indexes } from "./indexes.test-helper.ts";
import { DOMAINS, ENUMS, FOREIGN_KEYS, INDEXES, SCHEMAS, TABLES } from "./queries.ts";

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

function withIndex(row: DriverRow): Session {
  return sessionAnswering(
    new Map([
      [SCHEMAS, [{ name: "app" }]],
      [TABLES, [{ schema: "app", name: "t" }]],
      [INDEXES, [row]],
    ]),
  );
}

describe("introspect, given index rows the catalog query never returns", () => {
  const base = { schema: "app", table: "t", name: "t_ix", method: "btree" };

  it("rejects an index with a method the catalog does not model", async () => {
    const session = withIndex({ ...base, method: "spgist", columns: [null], expressions: ["a"] });

    await expect(introspect(session)).rejects.toThrow('index "t_ix" has an unmodeled method');
  });

  it("rejects an index key with neither a column nor an expression", async () => {
    const session = withIndex({ ...base, columns: [null], expressions: [null] });

    await expect(introspect(session)).rejects.toThrow(
      "an index key has neither a column nor an expression",
    );
  });

  it("reads an index row without orders or an include list as ascending, with no include", async () => {
    const session = withIndex({ ...base, columns: [null], expressions: ["(a + 1)"] });

    expect(indexes(await introspect(session))).toStrictEqual([
      [
        "app.t.t_ix",
        {
          unique: false,
          method: "btree",
          keys: [expression("a + 1")],
          include: [],
          where: undefined,
          nullsNotDistinct: false,
        },
      ],
    ]);
  });

  it("reads an index row without a column list as an index with no keys", async () => {
    const session = withIndex(base);

    expect(indexes(await introspect(session)).map(([, payload]) => payload.keys)).toStrictEqual([
      [],
    ]);
  });
});
