import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type IndexPayload } from "../catalog/index.ts";
import { diff } from "./diff.ts";
import { ADD, DROP, PLAIN } from "./foreign-keys.test-helper.ts";

type Types = { readonly users: string; readonly orders: string };

/** `users (id)` with a primary key, and `orders (user_id)` with the plain foreign key to it. */
function database(
  { users, orders }: Types,
  { key = true, index }: { readonly key?: boolean; readonly index?: Partial<IndexPayload> } = {},
): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: users, notNull: true });
  if (key) builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
  if (index !== undefined) {
    builder.index("public", "users", "users_id_idx", {
      unique: false,
      method: "btree",
      keys: [{ column: "id", descending: false, nullsFirst: false }],
      include: [],
      where: undefined,
      nullsNotDistinct: false,
      ...index,
    });
  }
  builder.table("public", "orders");
  builder.column("public", "orders", "user_id", { type: orders, notNull: false });
  builder.foreignKey("public", "orders", "orders_user_id_fkey", PLAIN);
  return builder.build();
}

/**
 * `public.users` and `other.users`, both with an `id`, and a foreign key on `public.orders` to
 * `other.users`. Only `other.users` always has a primary key.
 */
function inTwoSchemas(publicKey: boolean): Catalog {
  const builder = catalogBuilder();
  for (const schema of ["public", "other"]) {
    builder.schema(schema);
    builder.table(schema, "users");
    builder.column(schema, "users", "id", { type: "integer", notNull: true });
  }
  if (publicKey) builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
  builder.primaryKey("other", "users", "users_pkey", { columns: ["id"] });
  builder.table("public", "orders");
  builder.column("public", "orders", "user_id", { type: "integer", notNull: false });
  builder.foreignKey("public", "orders", "orders_user_id_fkey", {
    ...PLAIN,
    target: { ...PLAIN.target, schema: "other" },
  });
  return builder.build();
}

const INTEGERS: Types = { users: "integer", orders: "integer" };

/** The statements of the diff, each without its hazard comments. */
function statements(from: Catalog, to: Catalog): string[] {
  return diff(from, to)
    .sql.split("\n\n")
    .map((statement) => statement.replaceAll(/^-- hazard: \w+\n/gmu, "").trim());
}

describe("rebuilding an unchanged foreign key", () => {
  it("drops it before and adds it back after a retype of the referencing column", () => {
    const sql = statements(database(INTEGERS), database({ users: "integer", orders: "text" }));

    expect(sql).toStrictEqual([
      DROP,
      `alter table "public"."orders" alter column "user_id" type text;`,
      expect.stringContaining(ADD),
    ]);
  });

  it("drops it before and adds it back after a retype of the target column", () => {
    const sql = statements(database(INTEGERS), database({ users: "text", orders: "integer" }));

    expect(sql.at(0)).toBe(DROP);
    expect(sql.at(-1)).toContain(ADD);
  });

  it("flags the add as a long lock, as any foreign key added to an existing table is", () => {
    const { hazards } = diff(database(INTEGERS), database({ users: "integer", orders: "text" }));

    expect(hazards.map(({ kind }) => kind)).toContain("share_row_exclusive_lock");
  });

  it.each([
    ["integer", "bigint"],
    ["bigint", "smallint"],
    ["text", "character varying(20)"],
    ["character varying(20)", "text"],
    ["character varying(10)", "character varying(20)"],
    ["numeric(10,2)", "numeric(12,2)"],
  ])("keeps it through a retype from %s to %s", (before, after) => {
    const from = { users: before, orders: before };

    expect(statements(database(from), database({ ...from, orders: after }))).toStrictEqual([
      `alter table "public"."orders" alter column "user_id" type ${after};`,
    ]);
    expect(statements(database(from), database({ ...from, users: after }))).toStrictEqual([
      `alter table "public"."users" alter column "id" type ${after};`,
    ]);
  });

  it.each([
    ["integer", "numeric(10,0)"],
    ["integer", "text"],
    ["integer[]", "bigint[]"],
    ["character varying(20)[]", "character varying(40)[]"],
    ["character(5)", "text"],
    ["timestamp without time zone", "timestamp with time zone"],
  ])("rebuilds it around a retype from %s to %s", (before, after) => {
    const sql = statements(
      database({ users: before, orders: before }),
      database({ users: before, orders: after }),
    );

    expect(sql.at(0)).toBe(DROP);
  });

  it.each([
    ["a plain index", {}],
    ["a partial unique index", { unique: true, where: "(id > 0)" }],
    [
      "a unique index on the column and an expression",
      {
        unique: true,
        keys: [
          { column: "id", descending: false, nullsFirst: false },
          { expression: "id + 1", descending: false, nullsFirst: false },
        ],
      },
    ],
  ])("keeps it when %s on the target column drops", (_, index) => {
    const sql = statements(database(INTEGERS, { index }), database(INTEGERS));

    expect(sql).toStrictEqual([`drop index "public"."users_id_idx";`]);
  });

  it("rebuilds it around a dropped unique index on the target column", () => {
    const sql = statements(database(INTEGERS, { index: { unique: true } }), database(INTEGERS));

    expect(sql.at(0)).toBe(DROP);
    expect(sql.at(-1)).toContain(ADD);
  });

  it("keeps it when the key that drops sits on a same-named table in another schema", () => {
    expect(statements(inTwoSchemas(true), inTwoSchemas(false))).toStrictEqual([
      `alter table "public"."users" drop constraint "users_pkey";`,
    ]);
  });

  it("rebuilds it around a dropped target key", () => {
    const sql = statements(database(INTEGERS), database(INTEGERS, { key: false }));

    expect(sql).toStrictEqual([
      DROP,
      `alter table "public"."users" drop constraint "users_pkey";`,
      expect.stringContaining(ADD),
    ]);
  });
});
