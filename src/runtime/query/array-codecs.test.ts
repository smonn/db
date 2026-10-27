import { beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
  type Codec,
  type Row,
} from "../definition/index.ts";
import { createClient, from, insert, sql, type NewRow } from "./index.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

type Boxed<T> = { readonly v: T };
const boxed = <T>(): Codec<T, Boxed<T>> => ({ decode: (v) => ({ v }), encode: (box) => box.v });

type Label = "light" | "a,b" | "NULL";
const shade = defineEnum(["light", "a,b", "NULL"] as const);
const small = defineDomain((c) => c.integer());
const t = defineTable((c) => ({
  id: c.integer().notNull(),
  days: c.date().codec(boxed<string>()).array(),
  counts: c.integer().codec(boxed<number>()).array(),
  shades: c.enum(shade).codec(boxed<Label>()).array(),
  smalls: c.domain(small).codec(boxed<number>()).array(),
}));
const db = defineDatabase({ public: { shade, small, t } });

const setup = [
  "drop table if exists public.t",
  "drop domain if exists public.small",
  "drop type if exists public.shade",
  "create type public.shade as enum ('light', 'a,b', 'NULL')",
  "create domain public.small as integer",
  "create table public.t (id integer not null, days date[], counts integer[], shades public.shade[], smalls public.small[])",
].join("; ");

beforeAll(async () => {
  await testDatabase.driver.execute(setup);
});

beforeEach(async () => {
  await testDatabase.driver.execute("truncate public.t");
});

const wrapped: {
  days: (Boxed<string> | null)[];
  counts: (Boxed<number> | null)[];
  shades: (Boxed<Label> | null)[];
  smalls: (Boxed<number> | null)[];
} = {
  days: [{ v: "2024-02-29" }, null],
  counts: [{ v: 1 }, null, { v: 3 }],
  shades: [{ v: "a,b" }, null, { v: "NULL" }],
  smalls: [{ v: 7 }, null],
};

async function seed(): Promise<void> {
  await client.run(insert(db.public.t).values({ id: 1, ...wrapped }));
}

describe("types", () => {
  it("reads (Value | null)[] in Row and NewRow", () => {
    expectTypeOf<Row<typeof t>["days"]>().toEqualTypeOf<(Boxed<string> | null)[] | null>();
    expectTypeOf<Row<typeof t>["shades"]>().toEqualTypeOf<(Boxed<Label> | null)[] | null>();
    expectTypeOf<NewRow<typeof db.public.t>["counts"]>().toEqualTypeOf<
      (Boxed<number> | null)[] | null | undefined
    >();
  });

  it("offers no codec on a whole array", () => {
    const { columns } = defineTable((c) => ({ a: c.integer().array() }));
    /* oxlint-disable typescript/no-unsafe-call -- the missing method is the point. */
    // @ts-expect-error -- an array column takes its codec before .array()
    columns.a.codec(boxed<number>());
    /* oxlint-enable typescript/no-unsafe-call */
    expectTypeOf(columns.a).not.toHaveProperty("codec");
  });

  it("types a predicate value against the element Value", () => {
    const ok = from(db.public.t).where((r) => r.counts.eq([{ v: 1 }, null]));
    // @ts-expect-error -- the base number is no longer the element
    const bad = from(db.public.t).where((r) => r.counts.eq([1, null]));
    expect(ok).toBeDefined();
    expect(bad).toBeDefined();
  });
});

describe("element codecs on array columns", () => {
  it("encodes each element on insert and skips NULL elements", async () => {
    await seed();

    const raw = await client.all(
      sql<Record<string, string>>`
        select days::text, counts::text, shades::text, smalls::text from public.t
      `,
    );

    expect(raw).toStrictEqual([
      {
        days: "{2024-02-29,NULL}",
        counts: "{1,NULL,3}",
        shades: '{"a,b",NULL,"NULL"}',
        smalls: "{7,NULL}",
      },
    ]);
  });

  it("decodes each element on select, for built-in, enum, and domain arrays", async () => {
    await seed();

    const rows = await client.all(from(db.public.t));

    expect(rows).toStrictEqual([{ id: 1, ...wrapped }]);
  });

  it("decodes insert returning", async () => {
    const row = await client.one(
      insert(db.public.t)
        .values({ id: 1, ...wrapped })
        .returning((r) => ({ counts: r.counts, shades: r.shades })),
    );

    expect(row).toStrictEqual({ counts: wrapped.counts, shades: wrapped.shades });
  });

  it("encodes the elements of a predicate value", async () => {
    await seed();
    const pick = from(db.public.t).select((r) => ({ id: r.id }));

    const hit = [
      await client.all(pick.where((r) => r.days.eq([{ v: "2024-02-29" }, null]))),
      await client.all(pick.where((r) => r.counts.eq([{ v: 1 }, null, { v: 3 }]))),
      await client.all(pick.where((r) => r.shades.eq([{ v: "a,b" }, null, { v: "NULL" }]))),
      await client.all(pick.where((r) => r.smalls.eq([{ v: 7 }, null]))),
    ];
    const miss = [
      await client.all(pick.where((r) => r.counts.eq([{ v: 1 }, null, { v: 4 }]))),
      await client.all(pick.where((r) => r.shades.ne([{ v: "a,b" }, null, { v: "NULL" }]))),
    ];

    expect(hit).toStrictEqual([[{ id: 1 }], [{ id: 1 }], [{ id: 1 }], [{ id: 1 }]]);
    expect(miss).toStrictEqual([[], []]);
  });

  it("round-trips an empty array and a NULL column", async () => {
    await client.run(insert(db.public.t).values([{ id: 1, days: [] }, { id: 2 }]));

    const rows = await client.all(from(db.public.t));

    expect(rows).toStrictEqual([
      { id: 1, days: [], counts: null, shades: null, smalls: null },
      { id: 2, days: null, counts: null, shades: null, smalls: null },
    ]);
  });

  it("names the column when an element's codec throws", async () => {
    const bad = defineTable((c) => ({
      n: c
        .integer()
        .codec({
          decode: (): never => {
            throw new Error("no");
          },
          encode: (value: number) => value,
        })
        .array(),
    }));
    const badDb = defineDatabase({ public: { bad } });
    await testDatabase.driver.execute(
      "drop table if exists public.bad; create table public.bad (n integer[]); insert into public.bad values ('{1}')",
    );

    await expect(client.all(from(badDb.public.bad))).rejects.toThrow(
      `The codec of column "n" of "public"."bad" threw while decoding a value`,
    );
  });
});

describe("array elements are mapped one level deep", () => {
  const pipes: Codec<string, string[]> = {
    decode: (s) => s.split("|"),
    encode: (parts) => parts.join("|"),
  };
  const nested = defineTable((c) => ({
    id: c.integer().notNull(),
    parts: c.text().codec(pipes).array(),
    docs: c
      .jsonb<number[]>()
      .codec<{ n: number[] }>({ decode: (n) => ({ n }), encode: (doc) => doc.n })
      .array(),
  }));
  const nestedDb = defineDatabase({ public: { nested } });

  beforeAll(async () => {
    await testDatabase.driver.execute(
      "drop table if exists public.nested; create table public.nested (id integer not null, parts text[], docs jsonb[])",
    );
  });

  it("hands an array-valued codec its whole Value, on insert, select, and eq", async () => {
    await client.run(insert(nestedDb.public.nested).values({ id: 1, parts: [["a", "b"], ["c"]] }));

    const raw = await client.all(sql<{ parts: string }>`select parts::text from public.nested`);
    const rows = await client.all(from(nestedDb.public.nested).select((r) => ({ parts: r.parts })));
    const hit = await client.all(
      from(nestedDb.public.nested)
        .where((r) => r.parts.eq([["a", "b"], ["c"]]))
        .select((r) => ({ id: r.id })),
    );

    expect(raw).toStrictEqual([{ parts: "{a|b,c}" }]);
    expect(rows).toStrictEqual([{ parts: [["a", "b"], ["c"]] }]);
    expect(hit).toStrictEqual([{ id: 1 }]);
  });

  it("decodes a jsonb[] whose elements are JSON arrays once per element", async () => {
    await testDatabase.driver.execute(
      `insert into public.nested (id, docs) values (2, array['[1,2]'::jsonb])`,
    );

    const rows = await client.all(
      from(nestedDb.public.nested)
        .where((r) => r.id.eq(2))
        .select((r) => ({ docs: r.docs })),
    );

    expect(rows).toStrictEqual([{ docs: [{ n: [1, 2] }] }]);
  });
});
