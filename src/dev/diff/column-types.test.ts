import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { catalogBuilder, definitionCatalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

const db = useTestDatabase();

const allTypes = defineTable((c) => ({
  text: c.text(),
  varchar: c.varchar(20),
  smallint: c.smallint(),
  integer: c.integer(),
  bigint: c.bigint(),
  numeric: c.numeric(),
  numericP: c.numeric(10),
  numericPS: c.numeric(10, 2),
  real: c.real(),
  doublePrecision: c.doublePrecision(),
  boolean: c.boolean(),
  uuid: c.uuid(),
  date: c.date(),
  timestamp: c.timestamp(),
  timestamptz: c.timestamptz(),
  jsonb: c.jsonb(),
  bytea: c.bytea().notNull(),
}));

beforeEach(async () => {
  await db.driver.execute("drop schema if exists types cascade; drop schema public cascade");
  await db.driver.execute("create schema public");
});

describe("column types", () => {
  it("renders each type in create table and add column", () => {
    const to = definitionCatalog(defineDatabase({ types: { everything: allTypes } }));
    const created = diff(new Map(), to);
    const empty = catalogBuilder();
    empty.schema("types");
    empty.table("types", "everything");
    const added = diff(empty.build(), to);

    expect(created).toBe(`create schema "types";

create table "types"."everything" (
  "text" text,
  "varchar" character varying(20),
  "smallint" smallint,
  "integer" integer,
  "bigint" bigint,
  "numeric" numeric,
  "numericP" numeric(10,0),
  "numericPS" numeric(10,2),
  "real" real,
  "doublePrecision" double precision,
  "boolean" boolean,
  "uuid" uuid,
  "date" date,
  "timestamp" timestamp without time zone,
  "timestamptz" timestamp with time zone,
  "jsonb" jsonb,
  "bytea" bytea not null
);
`);
    expect(added).toContain(
      `alter table "types"."everything" add column "varchar" character varying(20);`,
    );
    expect(added).toContain(
      `alter table "types"."everything" add column "numericPS" numeric(10,2);`,
    );
    expect(added).toContain(
      `alter table "types"."everything" add column "timestamptz" timestamp with time zone;`,
    );
    expect(added.match(/add column/gu)).toHaveLength(17);
  });

  it("applies to Postgres and introspects back with no remaining diff", async () => {
    const wanted = definitionCatalog(
      defineDatabase({ public: {}, types: { everything: allTypes } }),
    );

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const actual = await introspect(db.driver);
    expect(diff(actual, wanted)).toBe("");
    expect([...actual.values()].filter((fact) => fact.name === "numericP")).toStrictEqual([
      expect.objectContaining({ payload: { type: "numeric(10,0)", notNull: false } }),
    ]);
  });

  it("adds every type to an existing table with no remaining diff", async () => {
    await db.driver.execute('create schema types; create table types.everything ("text" text)');
    const wanted = definitionCatalog(
      defineDatabase({ public: {}, types: { everything: allTypes } }),
    );

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(diff(await introspect(db.driver), wanted)).toBe("");
  });
});
