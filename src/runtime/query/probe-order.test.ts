import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import { from } from "./index.ts";

const mood = defineEnum(["sad", "ok", "happy"]);
const label = defineDomain((c) => c.text());
const posint = defineDomain((c) => c.integer());
const blob = defineDomain((c) => c.bytea());
const doc = defineDomain((c) => c.jsonb<{ n: number }>());
const stamp = defineDomain((c) => c.timestamptz());

const items = defineTable((c) => ({
  id: c.integer().primaryKey(),
  name: c.text().notNull(),
  nick: c.varchar(20),
  code: c.uuid(),
  mood: c.enum(mood),
  label: c.domain(label),
  qty: c.domain(posint),
  tags: c.text().array(),
  moods: c.enum(mood).array(),
  meta: c.jsonb<string[]>(),
  blob: c.domain(blob),
  doc: c.domain(doc),
  stamp: c.domain(stamp),
}));
const db = defineDatabase({ public: { mood, label, posint, blob, doc, stamp, items } });

const orderByMisuses = () => [
  // @ts-expect-error -- a predicate isn't an ordering
  from(db.public.items).orderBy((u) => u.id.eq(1)),
  // @ts-expect-error -- a column name string isn't a column
  from(db.public.items).orderBy(() => "id"),
  // @ts-expect-error -- no tuple form
  from(db.public.items).orderBy((u) => [u.id, "desc"]),
  // @ts-expect-error -- nulls only on nullable columns
  from(db.public.items).orderBy((u) => u.name.asc({ nulls: "first" })),
  // @ts-expect-error -- not a nulls value
  from(db.public.items).orderBy((u) => u.nick.asc({ nulls: "middle" })),
];

describe("orderBy types", () => {
  it("takes a bare column, an ordering, or an array of either", () => {
    const query = from(db.public.items)
      .orderBy((u) => u.name)
      .orderBy((u) => u.id.desc())
      .orderBy((u) => [u.qty, u.nick.desc({ nulls: "last" }), u.mood.asc()]);
    expectTypeOf(query.toSql().text).toBeString();
  });

  it("refuses a predicate, a string, a tuple, and nulls on a NOT NULL column", () => {
    expectTypeOf(orderByMisuses).toBeFunction();
  });
});

/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return -- each rejected call is the point. */
describe("comparison types", () => {
  it("offers like on text, varchar, and a domain over text only", () => {
    expectTypeOf(from(db.public.items).where((u) => u.name.like("A%"))).toBeObject();
    expectTypeOf(from(db.public.items).where((u) => u.nick.ilike("a%"))).toBeObject();
    expectTypeOf(from(db.public.items).where((u) => u.label.like("x%"))).toBeObject();
    // @ts-expect-error -- uuid has no like
    from(db.public.items).where((u) => u.code.like("1%"));
    // @ts-expect-error -- an enum has no like
    from(db.public.items).where((u) => u.mood.like("s%"));
    // @ts-expect-error -- a text array has no like
    from(db.public.items).where((u) => u.tags.like("a%"));
  });

  it("types in elements as the column's non-null value", () => {
    expectTypeOf(from(db.public.items).where((u) => u.mood.in(["sad", "ok"]))).toBeObject();
    // @ts-expect-error -- null is no element
    from(db.public.items).where((u) => u.nick.in([null]));
    // @ts-expect-error -- not an enum label
    from(db.public.items).where((u) => u.mood.in(["angry"]));
    // @ts-expect-error -- a string isn't an integer
    from(db.public.items).where((u) => u.qty.in(["1"]));
  });

  it("offers includes on array columns only", () => {
    expectTypeOf(from(db.public.items).where((u) => u.moods.includes("ok"))).toBeObject();
    // @ts-expect-error -- not an array column
    from(db.public.items).where((u) => u.name.includes("a"));
    // @ts-expect-error -- not an enum label
    from(db.public.items).where((u) => u.moods.includes("angry"));
  });

  it("decided shape: a jsonb<string[]> column and in on an array column both compile", () => {
    // Both fail on Postgres; see the runtime tests below.
    expectTypeOf(from(db.public.items).where((u) => u.meta.includes("a"))).toBeObject();
    expectTypeOf(from(db.public.items).where((u) => u.tags.in([["a", "b"]]))).toBeObject();
  });
});
/* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return */

describe("rendered SQL", () => {
  it("appends orderings and binds limit and offset", () => {
    const sql = from(db.public.items)
      .select((u) => ({ id: u.id }))
      .orderBy((u) => u.name)
      .orderBy((u) => [u.nick.desc({ nulls: "last" }), u.id.desc()])
      .limit(10)
      .offset(20)
      .toSql();
    expect(sql).toStrictEqual({
      text: 'select "id" from "public"."items" order by "name" asc, "nick" desc nulls last, "id" desc limit $1 offset $2',
      params: [10, 20],
    });
  });

  it("renders in and notIn as any and all over one array-text param, with no cast", () => {
    const sql = from(db.public.items)
      .select((u) => ({ id: u.id }))
      .where((u) => u.mood.in(["sad", "ok"]))
      .where((u) => u.qty.notIn([]))
      .toSql();
    expect(sql).toStrictEqual({
      text: 'select "id" from "public"."items" where ("mood" = any($1) and "qty" <> all($2))',
      params: ['{"sad","ok"}', "{}"],
    });
  });

  it("renders includes with the value first", () => {
    const sql = from(db.public.items)
      .select((u) => ({ id: u.id }))
      .where((u) => u.tags.includes("a"))
      .toSql();
    expect(sql.text).toBe('select "id" from "public"."items" where $1 = any("tags")');
  });
});

describe("runtime checks", () => {
  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 53])("limit and offset refuse %s", (count) => {
    expect(() => from(db.public.items).limit(count)).toThrow(
      `limit takes a non-negative safe integer, got ${count}`,
    );
    expect(() => from(db.public.items).offset(count)).toThrow(
      `offset takes a non-negative safe integer, got ${count}`,
    );
  });

  it("refuses what a JavaScript caller passes orderBy by name", () => {
    expect(() =>
      // @ts-expect-error -- a JavaScript caller
      from(db.public.items).orderBy(() => "id"),
    ).toThrow("orderBy takes a column, column.asc(), or column.desc(), got string");
    expect(() =>
      from(db.public.items).orderBy((u) =>
        // @ts-expect-error -- a JavaScript caller
        u.nick.asc({ nulls: "middle" }),
      ),
    ).toThrow('nulls takes "first" or "last", got "middle"');
  });
});
