import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable, type Target } from "../../runtime/definition/index.ts";
import { catalogBuilder, type Catalog } from "./catalog.ts";
import { definitionCatalog } from "./definition-catalog.ts";

const users = defineTable((c) => ({
  id: c.integer().primaryKey(),
  email: c.text().unique(),
}));

const facts = (catalog: Catalog) => [...catalog.values()].filter((f) => f.kind === "foreign key");

describe("a foreign key in the Definition catalog", () => {
  it("is a fact under its table, keyed apart from columns, with every part of its payload", () => {
    const orders = defineTable((c) => ({
      user_id: c
        .integer()
        .notNull()
        .references(() => users.columns.id, { onDelete: "cascade", deferrable: "deferred" }),
    }));
    const catalog = definitionCatalog(defineDatabase({ public: { users, orders } }));

    expect([...catalog].filter(([, fact]) => fact.kind === "foreign key")).toStrictEqual([
      [
        "public\0orders\0\0orders_user_id_fkey",
        {
          kind: "foreign key",
          name: "orders_user_id_fkey",
          parent: "public\0orders",
          payload: {
            columns: ["user_id"],
            target: { schema: "public", table: "users", columns: ["id"] },
            onDelete: "cascade",
            onUpdate: "no action",
            match: "simple",
            deferrable: "deferred",
          },
        },
      ],
    ]);
  });

  it("points at a table in another schema, and a unique column", () => {
    const orders = defineTable((c) => ({
      email: c.text().references(() => users.columns.email, { onUpdate: "cascade" }),
    }));
    const [fact] = facts(definitionCatalog(defineDatabase({ shop: { orders }, auth: { users } })));

    expect(fact?.payload).toMatchObject({
      columns: ["email"],
      target: { schema: "auth", table: "users", columns: ["email"] },
      onUpdate: "cascade",
    });
  });

  it("is added for each referencing column, after the table's keys", () => {
    const pairs = defineTable((c) => ({
      a: c.integer().references(() => users.columns.id),
      b: c.integer().references(() => users.columns.id, { name: "pairs_b" }),
    }));
    const catalog = definitionCatalog(defineDatabase({ public: { users, pairs } }));

    expect(facts(catalog).map((fact) => fact.name)).toStrictEqual(["pairs_a_fkey", "pairs_b"]);
  });

  it("can point back along a cycle", () => {
    const first = defineTable((c) => ({
      id: c.integer().primaryKey(),
      second_id: c.integer().references((): Target<number> => second.columns.id),
    }));
    const second = defineTable((c) => ({
      id: c.integer().primaryKey(),
      first_id: c.integer().references(() => first.columns.id),
    }));

    expect(facts(definitionCatalog(defineDatabase({ public: { first, second } })))).toHaveLength(2);
  });
});

const named = (name: string) =>
  definitionCatalog(
    defineDatabase({
      public: {
        users,
        orders: defineTable((c) => ({
          user_id: c.integer().references(() => users.columns.id, { name }),
        })),
      },
    }),
  );

const derived = (table: string, column: string) => {
  const t = defineTable((c) => ({
    id: c.integer().primaryKey(),
    [column]: c.integer().references(() => users.columns.id),
  }));
  return definitionCatalog(defineDatabase({ public: { users, [table]: t } }));
};

describe("a foreign key name", () => {
  it("takes Postgres's default, <table>_<columns>_fkey, without one", () => {
    expect(facts(derived("orders", "user_id")).map((f) => f.name)).toStrictEqual([
      "orders_user_id_fkey",
    ]);
  });

  it("is kept as written", () => {
    expect(facts(named("fk_orders_user")).map((f) => f.name)).toStrictEqual(["fk_orders_user"]);
  });

  it("is refused over 63 bytes, derived or written, and when empty", () => {
    const tooLong = "t".repeat(55);
    expect(() => derived(tooLong, "user_id")).toThrow("is longer than 63 bytes");
    expect(() => named("n".repeat(64))).toThrow("is longer than 63 bytes");
    expect(() => named("n".repeat(63))).not.toThrow();
    expect(() => named("é".repeat(32))).toThrow("is longer than 63 bytes");
    expect(() => named("")).toThrow("has an empty constraint name");
  });

  it("can't repeat on one table, and the error names both foreign keys", () => {
    const orders = defineTable((c) => ({
      a: c.integer().references(() => users.columns.id, { name: "same" }),
      b: c.integer().references(() => users.columns.id, { name: "same" }),
    }));

    expect(() => definitionCatalog(defineDatabase({ public: { users, orders } }))).toThrow(
      'the foreign key on "public"."orders" ("a") and the foreign key on "public"."orders" ("b") both take the constraint name "same"',
    );
  });

  it("can't take the name of a key on its own table", () => {
    const orders = defineTable((c) => ({
      id: c.integer().primaryKey({ name: "taken" }),
      user_id: c.integer().references(() => users.columns.id, { name: "taken" }),
    }));

    expect(() => definitionCatalog(defineDatabase({ public: { users, orders } }))).toThrow(
      'both take the constraint name "taken"',
    );
  });

  it("can repeat across tables, or match a table, since a foreign key owns no index", () => {
    const point = () =>
      defineTable((c) => ({
        user_id: c.integer().references(() => users.columns.id, { name: "orders" }),
      }));
    const catalog = definitionCatalog(
      defineDatabase({ public: { users, first: point(), orders: point() } }),
    );

    expect(facts(catalog).map((f) => f.name)).toStrictEqual(["orders", "orders"]);
  });
});

const payload = {
  columns: ["a"],
  target: { schema: "public", table: "users", columns: ["id"] },
  onDelete: "no action",
  onUpdate: "no action",
  match: "simple",
  deferrable: "not deferrable",
} as const;

function builderWithTable() {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  builder.column("public", "t", "a", { type: "integer", notNull: false });
  return builder;
}

describe("the catalog builder's foreign keys", () => {
  it("throws for a column its table lacks", () => {
    const builder = builderWithTable();
    expect(() => {
      builder.foreignKey("public", "t", "fk", { ...payload, columns: ["z"] });
    }).toThrow('column "public"."t"."z" isn\'t in the catalog');
  });

  it("throws at build for a target table or column it lacks", () => {
    const missingTable = builderWithTable();
    missingTable.foreignKey("public", "t", "fk", payload);
    expect(() => missingTable.build()).toThrow('table "public"."users" isn\'t in the catalog');

    const missingColumn = builderWithTable();
    missingColumn.table("public", "users");
    missingColumn.foreignKey("public", "t", "fk", payload);
    expect(() => missingColumn.build()).toThrow(
      'column "public"."users"."id" isn\'t in the catalog',
    );
  });

  it("accepts a target added after the foreign key", () => {
    const builder = builderWithTable();
    builder.foreignKey("public", "t", "fk", payload);
    builder.table("public", "users");
    builder.column("public", "users", "id", { type: "integer", notNull: true });

    expect(facts(builder.build())).toHaveLength(1);
  });
});
