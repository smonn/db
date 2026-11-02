import { describe, expect, it } from "vitest";
import { defineDatabase, defineEnum, defineTable } from "../definition/index.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";
import type { Statement } from "./statement.ts";

const mood = defineEnum(["happy", "sad"]);
const tone = defineEnum(["happy", "sad"]);

const db = defineDatabase(
  {
    public: {
      items: defineTable(
        (c) => ({
          id: c.integer().identity("always").primaryKey(),
          sku: c.text().notNull().unique(),
          a: c.text(),
          b: c.text(),
          tag: c.text(),
          deletedAt: c.timestamptz(),
          version: c.integer().notNull(),
          mood: c.enum(mood),
          tone: c.enum(tone),
        }),
        (t) => ({
          unique: [{ columns: [t.a, t.b] }],
          indexes: [{ columns: [t.tag], unique: true, where: sql`${t.deletedAt} is null` }],
        }),
      ),
      twice: defineTable(
        (c) => ({ tag: c.text(), gone: c.boolean() }),
        (t) => ({
          indexes: [
            { columns: [t.tag], where: sql`${t.gone} is true`, unique: true },
            { columns: [t.tag], where: sql`${t.gone} is false`, unique: true },
          ],
        }),
      ),
      both: defineTable(
        (c) => ({ tag: c.text().unique(), gone: c.boolean() }),
        (t) => ({ indexes: [{ columns: [t.tag], unique: true, where: sql`${t.gone}` }] }),
      ),
      others: defineTable((c) => ({ sku: c.text().notNull() })),
      indexed: defineTable(
        (c) => ({ e: c.text(), f: c.text(), g: c.text(), h: c.text() }),
        (t) => ({
          indexes: [
            { columns: [t.e, { key: t.f, order: "desc" }], unique: true },
            { columns: [sql`lower(${t.g})`], unique: true, name: "indexed_lower_g" },
            { columns: [t.h, sql`lower(${t.g})`], unique: true, name: "indexed_h_lower_g" },
            { columns: [t.g], where: sql`${t.h} is null` },
          ],
        }),
      ),
    },
  },
  { casing: "snake_case" },
);
const { items, twice, both, others, indexed } = db.public;

const row = { sku: "s", version: 1 };
const INSERT = 'insert into "public"."items" ("sku", "version") values ($1, $2)';

/** A plain-JS caller can pass what TypeScript rejects. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A plain-JS caller passes it; TypeScript rejects it.
const loose = (value: unknown): never => value as never;

describe("onConflict renders", () => {
  it("does nothing on a single-column key", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.sku])
        .doNothing()
        .toSql(),
    ).toStrictEqual({ text: `${INSERT} on conflict ("sku") do nothing`, params: ["s", 1] });
  });

  it("does nothing on the primary key, or on a full unique index's columns in any order", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.id])
        .doNothing()
        .toSql().text,
    ).toBe(`${INSERT} on conflict ("id") do nothing`);
    expect(
      insert(indexed)
        .values({ e: "e" })
        .onConflict((u) => [u.f, u.e])
        .doNothing()
        .toSql().text,
    ).toBe('insert into "public"."indexed" ("e") values ($1) on conflict ("f", "e") do nothing');
  });

  it("names a composite key's columns in the order given", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.b, u.a])
        .doNothing()
        .toSql().text,
    ).toBe(`${INSERT} on conflict ("b", "a") do nothing`);
  });

  it("appends the predicate of the partial unique index behind a target, in SQL names", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.tag])
        .doNothing()
        .toSql().text,
    ).toBe(`${INSERT} on conflict ("tag") where "deleted_at" is null do nothing`);
  });

  it("adds no predicate when a full key has the same columns as a partial index", () => {
    expect(
      insert(both)
        .values({ tag: "t" })
        .onConflict((u) => [u.tag])
        .doNothing()
        .toSql().text,
    ).toBe('insert into "public"."both" ("tag") values ($1) on conflict ("tag") do nothing');
  });

  it("sets literals, excluded columns, and Exprs naming both rows, skipping undefined", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.sku])
        .doUpdate((existing, excluded) => ({
          a: "x",
          b: undefined,
          tag: excluded.tag,
          version: sql.expr<number>`${existing.version} + ${excluded.version}`,
        }))
        .toSql(),
    ).toStrictEqual({
      text: `${INSERT} on conflict ("sku") do update set "a" = $3, "tag" = "excluded"."tag", "version" = ("public"."items"."version" + "excluded"."version")`,
      params: ["s", 1, "x"],
    });
  });

  it("combines each where with and, and qualifies the existing row by schema", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.sku])
        .doUpdate((_, excluded) => ({ version: excluded.version }))
        .where((existing, excluded) => excluded.version.gt(existing.version))
        .where((existing) => existing.deletedAt.isNull())
        .toSql().text,
    ).toBe(
      `${INSERT} on conflict ("sku") do update set "version" = "excluded"."version" where ("excluded"."version" > "public"."items"."version" and "public"."items"."deleted_at" is null)`,
    );
  });

  it("renders returning's columns bare after the conflict clause", () => {
    expect(
      insert(items)
        .values(row)
        .onConflict((u) => [u.sku])
        .doUpdate((_, excluded) => ({ version: excluded.version }))
        .where((existing) => existing.version.lt(5))
        .returning((u) => ({ id: u.id, deletedAt: u.deletedAt }))
        .toSql(),
    ).toStrictEqual({
      text: `${INSERT} on conflict ("sku") do update set "version" = "excluded"."version" where "public"."items"."version" < $3 returning "id", "deleted_at" as "deletedAt"`,
      params: ["s", 1, 5],
    });
  });
});

describe("onConflict refuses", () => {
  it("a target that is no key, or that two partial indexes back, naming the table", () => {
    expect(() =>
      insert(items)
        .values(row)
        .onConflict((u) => loose([u.a])),
    ).toThrow('("a") is not a key of "public"."items"');
    expect(() =>
      insert(twice)
        .values({ tag: "t" })
        .onConflict((u) => loose([u.tag])),
    ).toThrow('("tag") has several partial unique indexes and no full key on "public"."twice"');
  });

  it("a target only an expression index, a plain index, or two keys together cover", () => {
    const values = insert(indexed).values({ e: "e" });
    expect(() => values.onConflict((u) => loose([u.g]))).toThrow(
      '("g") is not a key of "public"."indexed"',
    );
    expect(() => values.onConflict((u) => loose([u.h]))).toThrow(
      '("h") is not a key of "public"."indexed"',
    );
    expect(() =>
      insert(items)
        .values(row)
        .onConflict((u) => loose([u.a, u.tag])),
    ).toThrow('("a", "tag") is not a key of "public"."items"');
  });

  it("a target callback that returns no list of the table's columns", () => {
    const message = "onConflict callback must return a list of the table's columns";
    const unfinished = insert(items).values(row);
    expect(() => unfinished.onConflict(() => loose([]))).toThrow(message);
    expect(() => unfinished.onConflict((u) => loose(u.sku))).toThrow(message);
    expect(() => unfinished.onConflict((u) => loose([u.sku, "a"]))).toThrow(message);
    expect(() => unfinished.onConflict(() => loose([{ "~column": "sku" }]))).toThrow(message);
  });

  it("an empty set, or a key that is no column", () => {
    const conflict = insert(items)
      .values(row)
      .onConflict((u) => [u.sku]);
    expect(() => conflict.doUpdate(() => ({ a: undefined }))).toThrow(
      "doUpdate needs at least one column to set",
    );
    expect(() => conflict.doUpdate(() => loose({ nope: 1 }))).toThrow(
      '"nope" is not a column of "public"."items"',
    );
  });

  it("a column of another table, or of an enum Postgres won't assign", () => {
    const conflict = insert(items)
      .values(row)
      .onConflict((u) => [u.sku]);
    let foreign: unknown;
    void insert(others)
      .values({ sku: "s" })
      .returning((o) => {
        foreign = o.sku;
        return { sku: o.sku };
      });
    expect(() => conflict.doUpdate(() => loose({ sku: foreign }))).toThrow(
      'doUpdate: "public"."items"."sku" takes a column of another table',
    );
    expect(() => conflict.doUpdate((_, excluded) => loose({ mood: excluded.tone }))).toThrow(
      `Can't compare "items"."mood" with "excluded"."tone"`,
    );
  });

  it("a where callback that returns no predicate, first or chained", () => {
    const updating = insert(items)
      .values(row)
      .onConflict((u) => [u.sku])
      .doUpdate((_, excluded) => ({ version: excluded.version }));
    const message = "doUpdate.where callback must return a predicate";
    expect(() => updating.where(() => loose(undefined))).toThrow(message);
    expect(() =>
      updating.where((existing) => existing.version.lt(5)).where(() => loose(undefined)),
    ).toThrow(message);
  });

  it("a doUpdate callback that returns nothing", () => {
    const conflict = insert(items)
      .values(row)
      .onConflict((u) => [u.sku]);
    const message = "doUpdate callback must return the columns to set";
    expect(() => conflict.doUpdate(() => loose(undefined))).toThrow(message);
    expect(() => conflict.doUpdate(() => loose(null))).toThrow(message);
  });

  it("a where comparing enums Postgres won't compare, first or chained", () => {
    const updating = insert(items)
      .values(row)
      .onConflict((u) => [u.sku])
      .doUpdate((_, excluded) => ({ version: excluded.version }));
    const message = `Can't compare "items"."mood" with "excluded"."tone"`;
    expect(() =>
      updating.where((existing, excluded) => existing.mood.eq(loose(excluded.tone))),
    ).toThrow(message);
    expect(() =>
      updating
        .where((existing) => existing.version.lt(5))
        .where((existing, excluded) => existing.mood.eq(loose(excluded.tone))),
    ).toThrow(message);
  });

  it("to render before doNothing or doUpdate", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A plain-JS caller passes it; TypeScript rejects it.
    const conflict = insert(items)
      .values(row)
      .onConflict((u) => [u.sku]) as unknown as Statement;
    expect(() => conflict.toSql()).toThrow(
      "onConflict needs doNothing() or doUpdate() before it runs",
    );
  });
});
