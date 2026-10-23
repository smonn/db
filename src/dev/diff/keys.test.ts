import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { diff } from "./diff.ts";

const db = useTestDatabase();

type Keys = {
  readonly primaryKey?: { readonly name: string; readonly columns: readonly string[] };
  readonly unique?: Readonly<Record<string, string>>;
};

/** A `public.t` table of NOT NULL text columns `a`, `b`, and `c`, with the given keys. */
function table(keys: Keys, names: readonly string[] = ["a", "b", "c"]): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const name of names) builder.column("public", "t", name, { type: "text", notNull: true });
  if (keys.primaryKey !== undefined) {
    const { name, columns } = keys.primaryKey;
    builder.primaryKey("public", "t", name, { columns });
  }
  for (const [name, column] of Object.entries(keys.unique ?? {})) {
    builder.unique("public", "t", name, { column });
  }
  return builder.build();
}

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("adding keys", () => {
  it("adds a composite primary key and a unique constraint with ALTER TABLE, after a new table", () => {
    const to = table({ primaryKey: { name: "t_pkey", columns: ["b", "a"] }, unique: { t_c: "c" } });
    const from = catalogBuilder();
    from.schema("public");

    expect(diff(from.build(), to)).toBe(`create table "public"."t" (
  "a" text not null,
  "b" text not null,
  "c" text not null
);

alter table "public"."t" add constraint "t_pkey" primary key ("b", "a");

alter table "public"."t" add constraint "t_c" unique ("c");
`);
  });

  it("adds keys to an existing table after its column changes", () => {
    const from = catalogBuilder();
    from.schema("public");
    from.table("public", "t");
    from.column("public", "t", "a", { type: "text", notNull: false });

    const sql = diff(
      from.build(),
      table({ primaryKey: { name: "t_pkey", columns: ["a"] } }, ["a", "b"]),
    );

    expect(sql.split("\n\n")).toStrictEqual([
      `alter table "public"."t" add column "b" text not null;`,
      `alter table "public"."t" alter column "a" set not null;`,
      `alter table "public"."t" add constraint "t_pkey" primary key ("a");\n`,
    ]);
  });

  it("quotes constraint and column names", () => {
    const to = table({ unique: { 'u"q': "a" } });
    const from = table({});

    expect(diff(from, to)).toBe(`alter table "public"."t" add constraint "u""q" unique ("a");\n`);
  });
});

describe("dropping and changing keys", () => {
  it("drops a unique constraint before a primary key, by name", () => {
    const from = table({ primaryKey: { name: "t_pkey", columns: ["a"] }, unique: { t_b: "b" } });

    expect(diff(from, table({})).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_b";`,
      `alter table "public"."t" drop constraint "t_pkey";\n`,
    ]);
  });

  it("drops a changed key and a removed key in the source catalog's order", () => {
    const from = table({ unique: { t_changed: "a", t_removed: "b" } });
    const to = table({ unique: { t_changed: "c" } });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_changed";`,
      `alter table "public"."t" drop constraint "t_removed";`,
      `alter table "public"."t" add constraint "t_changed" unique ("c");\n`,
    ]);
  });

  it("rebuilds a primary key whose columns change, dropping before adding", () => {
    const from = table({ primaryKey: { name: "t_pkey", columns: ["a"] } });
    const to = table({ primaryKey: { name: "t_pkey", columns: ["a", "b"] } });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_pkey";`,
      `alter table "public"."t" add constraint "t_pkey" primary key ("a", "b");\n`,
    ]);
  });

  it("rebuilds a unique constraint that moves to another column", () => {
    const from = table({ unique: { t_u: "a" } });
    const to = table({ unique: { t_u: "b" } });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_u";`,
      `alter table "public"."t" add constraint "t_u" unique ("b");\n`,
    ]);
  });

  it("treats a renamed constraint as a drop and an add", () => {
    const sql = diff(table({ unique: { old: "a" } }), table({ unique: { fresh: "a" } }));

    expect(sql.split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "old";`,
      `alter table "public"."t" add constraint "fresh" unique ("a");\n`,
    ]);
  });

  it("emits nothing when the keys match", () => {
    const keys = { primaryKey: { name: "t_pkey", columns: ["a", "b"] }, unique: { t_c: "c" } };
    expect(diff(table(keys), table(keys))).toBe("");
  });

  it("drops a key before dropping NOT NULL on its column", () => {
    const from = table({ primaryKey: { name: "t_pkey", columns: ["a"] } });
    const to = catalogBuilder();
    to.schema("public");
    to.table("public", "t");
    to.column("public", "t", "a", { type: "text", notNull: false });
    to.column("public", "t", "b", { type: "text", notNull: true });
    to.column("public", "t", "c", { type: "text", notNull: true });

    expect(diff(from, to.build()).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_pkey";`,
      `alter table "public"."t" alter column "a" drop not null;\n`,
    ]);
  });
});

describe("against Postgres", () => {
  it("creates keys and introspects back with no remaining diff", async () => {
    const wanted = table({
      primaryKey: { name: "t_pkey", columns: ["b", "a"] },
      unique: { t_c_key: "c" },
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const actual = await introspect(db.driver);
    expect(actual).toStrictEqual(wanted);
    expect(diff(actual, wanted)).toBe("");
  });

  it("keeps a unique constraint that duplicates the primary key", async () => {
    const wanted = table({
      primaryKey: { name: "t_pkey", columns: ["a"] },
      unique: { t_a_key: "a" },
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const { rows } = await db.driver.query(
      "select conname from pg_constraint where conrelid = 't'::regclass and contype in ('p', 'u') order by conname",
    );
    expect(rows.map((row) => row["conname"])).toStrictEqual(["t_a_key", "t_pkey"]);
    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });

  it("drops a unique constraint that duplicates the primary key and leaves the primary key", async () => {
    const both = table({
      primaryKey: { name: "t_pkey", columns: ["a"] },
      unique: { t_a_key: "a" },
    });
    await db.driver.execute(diff(await introspect(db.driver), both));
    const wanted = table({ primaryKey: { name: "t_pkey", columns: ["a"] } });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });

  it("changes, drops, and adds keys on an existing table in one migration", async () => {
    await db.driver.execute(`
      create table t (a text, b text not null, c text not null);
      alter table t add constraint t_pkey primary key (a);
      alter table t add constraint t_b_key unique (b);
      alter table t add constraint t_c_key unique (c);
    `);
    const wanted = table({
      primaryKey: { name: "t_pkey", columns: ["a", "b"] },
      unique: { t_c_other: "c" },
    });

    const sql = diff(await introspect(db.driver), wanted);
    await db.driver.execute(sql);

    expect(await introspect(db.driver)).toStrictEqual(wanted);
    expect(diff(await introspect(db.driver), wanted)).toBe("");
  });

  it("reads a constraint named like a column apart from that column", async () => {
    const wanted = table({ unique: { a: "a" } });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });
});
