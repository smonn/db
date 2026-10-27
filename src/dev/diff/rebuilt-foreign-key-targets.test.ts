import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { FK, PLAIN } from "./foreign-keys.test-helper.ts";
import { foreignKeysAround } from "./rebuilt.ts";
import { drop, NOTHING, statements, world, type Hook } from "./rebuilt-foreign-keys.test-helper.ts";

const uniqueOn =
  (columns: string[]): Hook =>
  (builder) => {
    builder.unique("public", "users", "users_a_b_key", { columns, nullsNotDistinct: false });
  };

/** `users (a, b, c)` with the given primary key, and `orders (x, y)` with a foreign key to `columns`. */
function composite(
  { x = "integer", b = "integer" }: { readonly x?: string; readonly b?: string },
  { key, columns, extra = NOTHING }: { key: string[]; columns: string[]; extra?: Hook },
): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "a", { type: "integer", notNull: true });
  builder.column("public", "users", "b", { type: b, notNull: true });
  builder.column("public", "users", "c", { type: "integer", notNull: true });
  builder.primaryKey("public", "users", "users_pkey", { columns: key });
  extra(builder);
  builder.table("public", "orders");
  builder.column("public", "orders", "x", { type: x, notNull: false });
  builder.column("public", "orders", "y", { type: "integer", notNull: false });
  builder.foreignKey("public", "orders", FK, {
    ...PLAIN,
    columns: ["x", "y"],
    target: { schema: "public", table: "users", columns },
  });
  return builder.build();
}

describe("a composite foreign key", () => {
  const shape = { key: ["a", "b"], columns: ["a", "b"] };

  it("rebuilds around a retype of one of its columns", () => {
    const sql = statements(composite({}, shape), composite({ x: "text" }, shape));

    expect(sql.at(0)).toBe(drop(FK));
    expect(sql.at(-1)).toContain("add constraint");
  });

  it("rebuilds around a retype of one of its target columns", () => {
    const sql = statements(composite({}, shape), composite({ b: "text" }, shape));

    expect(sql.at(0)).toBe(drop(FK));
    expect(sql.at(-1)).toContain("add constraint");
  });

  it("keeps it when a unique key that drops shares only some of its target columns", () => {
    const stays = { key: ["a", "c"], columns: ["a", "c"] };
    const from = composite({}, { ...stays, extra: uniqueOn(["a", "b"]) });

    expect(statements(from, composite({}, stays))).toStrictEqual([
      `alter table "public"."users" drop constraint "users_a_b_key";`,
    ]);
  });
});

describe("a foreign key to a table the catalog lacks", () => {
  it("is left alone", () => {
    const full = world();
    const dangling: Catalog = new Map(
      [...full].filter(([, fact]) => !["users", "id", "users_pkey"].includes(fact.name)),
    );

    expect(foreignKeysAround([], { from: dangling, to: dangling })).toStrictEqual([]);
  });
});

/** `users` and `orders`, plus a `decoy` table of the same schema whose `id` has the given type. */
function withDecoy(decoyId: string): Catalog {
  return world({
    beforeOrders: (builder) => {
      builder.table("public", "decoy");
      builder.column("public", "decoy", "id", { type: decoyId, notNull: true });
    },
  });
}

describe("a foreign key to a table beside another with the target's column name", () => {
  it("keeps it when only the other table's column is retyped", () => {
    const sql = statements(withDecoy("integer"), withDecoy("text"));

    expect(sql).toStrictEqual([`alter table "public"."decoy" alter column "id" type text;`]);
  });
});

/** A table `public` with a column `users` ahead of the real `users`, whose `id` has the given type. */
function lookalike(userId: string): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "public");
  builder.column("public", "public", "users", { type: "integer", notNull: false });
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: userId, notNull: true });
  builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
  builder.table("public", "orders");
  builder.column("public", "orders", "user_id", { type: "integer", notNull: false });
  builder.foreignKey("public", "orders", FK, PLAIN);
  return builder.build();
}

describe("a foreign key to a table that shares its name with a column", () => {
  it("looks the target up among tables only", () => {
    const sql = statements(lookalike("integer"), lookalike("text"));

    expect(sql.at(0)).toBe(drop(FK));
  });
});
