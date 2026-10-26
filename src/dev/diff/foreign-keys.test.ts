import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type ForeignKeyPayload } from "../catalog/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";

const PLAIN: ForeignKeyPayload = {
  columns: ["user_id"],
  target: { schema: "public", table: "users", columns: ["id"] },
  onDelete: "no action",
  onUpdate: "no action",
  match: "simple",
  deferrable: "not deferrable",
};

type Shape = {
  /** The tables `users` and `orders` exist unless this is false. */
  readonly orders?: boolean;
  readonly foreignKeys?: Readonly<Record<string, Partial<ForeignKeyPayload>>>;
  readonly users?: boolean;
};

/** `public.users (id)` and `public.orders (id, user_id)`, with the given foreign keys on `orders`. */
function database({ orders = true, users = true, foreignKeys = {} }: Shape): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  if (users) {
    builder.table("public", "users");
    builder.column("public", "users", "id", { type: "integer", notNull: true });
    builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
  }
  if (orders) {
    builder.table("public", "orders");
    builder.column("public", "orders", "id", { type: "integer", notNull: true });
    builder.column("public", "orders", "user_id", { type: "integer", notNull: false });
    for (const [name, payload] of Object.entries(foreignKeys)) {
      builder.foreignKey("public", "orders", name, { ...PLAIN, ...payload });
    }
  }
  return builder.build();
}

const FK = "orders_user_id_fkey";
const ADD = `alter table "public"."orders" add constraint "${FK}" foreign key ("user_id") references "public"."users" ("id")`;
const DROP = `alter table "public"."orders" drop constraint "${FK}";`;

describe("adding a foreign key", () => {
  it("is an ALTER TABLE ADD CONSTRAINT after the tables and keys it needs, never inline", () => {
    const sql = bareDiff(
      database({ users: false, orders: false }),
      database({
        foreignKeys: { [FK]: {} },
      }),
    );

    expect(sql.split("\n\n")).toStrictEqual([
      `create table "public"."users" (\n  "id" integer not null\n);`,
      `create table "public"."orders" (\n  "id" integer not null,\n  "user_id" integer\n);`,
      `alter table "public"."users" add constraint "users_pkey" primary key ("id");`,
      `${ADD};\n`,
    ]);
  });

  it("renders the actions, MATCH, and deferrable mode that differ from the defaults", () => {
    const to = database({
      foreignKeys: {
        a: { onDelete: "cascade" },
        b: { onUpdate: "set default" },
        c: { onDelete: "set null", onUpdate: "restrict", match: "full" },
        d: { deferrable: "deferred" },
        e: { deferrable: "immediate" },
      },
    });
    const sql = bareDiff(database({}), to)
      .split("\n\n")
      .map((statement) =>
        statement.replace(/^.*foreign key \("user_id"\) references "public"."users" \("id"\)/u, ""),
      );

    expect(sql).toStrictEqual([
      " on delete cascade;",
      " on update set default;",
      " match full on delete set null on update restrict;",
      " deferrable initially deferred;",
      " deferrable initially immediate;\n",
    ]);
  });

  it("quotes every identifier, including the target's schema", () => {
    const builder = catalogBuilder();
    builder.schema("a");
    builder.schema("b");
    builder.table("a", 't"1');
    builder.column("a", 't"1', "c", { type: "integer", notNull: true });
    builder.table("b", "t2");
    builder.column("b", "t2", 'x"y', { type: "integer", notNull: false });
    builder.foreignKey("b", "t2", 'f"k', {
      ...PLAIN,
      columns: ['x"y'],
      target: { schema: "a", table: 't"1', columns: ["c"] },
    });

    expect(bareDiff(catalogBuilder().build(), builder.build()).split("\n\n").at(-1)).toBe(
      `alter table "b"."t2" add constraint "f""k" foreign key ("x""y") references "a"."t""1" ("c");\n`,
    );
  });

  it("adds to an existing table after the column changes it needs, with the lock Hazard", () => {
    const from = catalogBuilder();
    from.schema("public");
    from.table("public", "users");
    from.column("public", "users", "id", { type: "integer", notNull: true });
    from.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
    from.table("public", "orders");
    from.column("public", "orders", "id", { type: "integer", notNull: true });

    const result = diff(from.build(), database({ foreignKeys: { [FK]: {} } }));

    expect(result.sql).toBe(
      `alter table "public"."orders" add column "user_id" integer;\n\n` +
        `-- hazard: share_row_exclusive_lock\n${ADD};\n`,
    );
    expect(result.hazards).toStrictEqual([
      { kind: "share_row_exclusive_lock", statement: `${ADD};` },
    ]);
  });

  it("carries no Hazard on a table created in the same migration", () => {
    const result = diff(database({ orders: false }), database({ foreignKeys: { [FK]: {} } }));

    expect(result.hazards).toStrictEqual([]);
  });
});

describe("dropping a foreign key", () => {
  it("is its own DROP CONSTRAINT before the table it points at drops", () => {
    const from = database({ foreignKeys: { [FK]: {} } });
    const to = catalogBuilder();
    to.schema("public");
    to.table("public", "orders");
    to.column("public", "orders", "id", { type: "integer", notNull: true });
    to.column("public", "orders", "user_id", { type: "integer", notNull: false });

    expect(bareDiff(from, to.build()).split("\n\n")).toStrictEqual([
      DROP,
      `drop table "public"."users";\n`,
    ]);
  });

  it("is dropped before the primary key it needs, which Postgres refuses to drop first", () => {
    const to = catalogBuilder();
    to.schema("public");
    to.table("public", "users");
    to.column("public", "users", "id", { type: "integer", notNull: true });
    to.table("public", "orders");
    to.column("public", "orders", "id", { type: "integer", notNull: true });
    to.column("public", "orders", "user_id", { type: "integer", notNull: false });

    expect(
      bareDiff(database({ foreignKeys: { [FK]: {} } }), to.build()).split("\n\n"),
    ).toStrictEqual([DROP, `alter table "public"."users" drop constraint "users_pkey";\n`]);
  });

  it("is added after the primary key it needs, on a table that gains both", () => {
    const from = catalogBuilder();
    from.schema("public");
    from.table("public", "users");
    from.column("public", "users", "id", { type: "integer", notNull: true });
    from.table("public", "orders");
    from.column("public", "orders", "id", { type: "integer", notNull: true });
    from.column("public", "orders", "user_id", { type: "integer", notNull: false });

    expect(
      bareDiff(from.build(), database({ foreignKeys: { [FK]: {} } })).split("\n\n"),
    ).toStrictEqual([
      `alter table "public"."users" add constraint "users_pkey" primary key ("id");`,
      `${ADD};\n`,
    ]);
  });

  it("is dropped even under a dropped table, since its target may drop first", () => {
    const from = database({ foreignKeys: { [FK]: {} } });
    const to = catalogBuilder();
    to.schema("public");

    expect(bareDiff(from, to.build()).split("\n\n")).toStrictEqual([
      DROP,
      `drop table "public"."users";`,
      `drop table "public"."orders";\n`,
    ]);
  });

  it("is dropped before a column it names, and carries no Hazard", () => {
    const from = database({ foreignKeys: { [FK]: {} } });
    const to = catalogBuilder();
    to.schema("public");
    to.table("public", "users");
    to.column("public", "users", "id", { type: "integer", notNull: true });
    to.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
    to.table("public", "orders");
    to.column("public", "orders", "id", { type: "integer", notNull: true });

    const result = diff(from, to.build());

    expect(result.sql).toBe(
      `${DROP}\n\n-- hazard: data_loss\nalter table "public"."orders" drop column "user_id";\n`,
    );
  });

  it("is dropped when the Definition stops declaring it", () => {
    const result = diff(database({ foreignKeys: { [FK]: {} } }), database({}));

    expect(result.sql).toBe(`${DROP}\n`);
    expect(result.hazards).toStrictEqual([]);
  });
});

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

  it("rebuilds one under a new name", () => {
    const sql = bareDiff(
      database({ foreignKeys: { old: {} } }),
      database({ foreignKeys: { fresh: {} } }),
    );

    expect(sql.split("\n\n")).toStrictEqual([
      `alter table "public"."orders" drop constraint "old";`,
      expect.stringContaining(`add constraint "fresh" foreign key`),
    ]);
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
