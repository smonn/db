import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable, type Codec, type Row } from "../definition/index.ts";
import { and, createClient, from, insert, not, or, sql, type NewRow } from "./index.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

type Day = { readonly iso: string };
const day: Codec<string, Day> = {
  decode: (base) => ({ iso: base }),
  encode: (value) => value.iso,
};

const events = defineTable((c) => ({
  id: c.integer().primaryKey(),
  happened: c.date().codec(day).notNull(),
  due: c.date().codec(day),
  note: c.text(),
}));
const db = defineDatabase({ public: { events } });

beforeEach(async () => {
  await testDatabase.driver.execute(
    `drop table if exists public.events; create table public.events (id integer primary key, happened date, due date, note text)`,
  );
});

describe("types", () => {
  it("reads the codec's Value in Row and NewRow, with null for a nullable column", () => {
    expectTypeOf<Row<typeof events>>().toEqualTypeOf<{
      id: number;
      happened: Day;
      due: Day | null;
      note: string | null;
    }>();
    expectTypeOf<NewRow<typeof db.public.events>>().toEqualTypeOf<
      { id: number; happened: Day } & { due?: Day | null; note?: string | null }
    >();
  });

  it("keeps the Value when notNull() comes after codec()", () => {
    const column = defineTable((c) => ({ d: c.date().codec(day).notNull() })).columns.d;
    expectTypeOf(column).toExtend<{ "~types": { value: Day; notNull: true } }>();
  });

  it("refuses a second codec", () => {
    const once = defineTable((c) => ({ d: c.date().codec(day) })).columns.d;
    expectTypeOf(once).not.toHaveProperty("codec");
  });

  it("refuses a codec whose Base is not the column's base value", () => {
    // @ts-expect-error a date column's base value is a string
    const table = defineTable((c) => ({ n: c.integer().codec(day) }));
    expect(table.columns.n["~codec"]).toBe(day);
  });

  it("types predicates against the codec's Value", () => {
    const ok = from(db.public.events).where((e) => e.happened.eq({ iso: "2024-01-01" }));
    // @ts-expect-error the base string is no longer the value
    const bad = from(db.public.events).where((e) => e.happened.eq("2024-01-01"));
    expect(ok).toBeDefined();
    expect(bad).toBeDefined();
  });
});

describe("codec through the query layer", () => {
  it("has no catalog effect: the column's state is the plain column's", () => {
    const plain = defineTable((c) => ({ d: c.date() })).columns.d;
    const coded = defineTable((c) => ({ d: c.date().codec(day) })).columns.d;
    expect(coded.state).toStrictEqual(plain.state);
  });

  it("keeps the codec through later modifiers", () => {
    const column = defineTable((c) => ({ d: c.date().codec(day).notNull().default("now()") }))
      .columns.d;
    expect(column["~codec"]).toBe(day);
  });

  it("encodes insert values and decodes insert returning, matched by alias", async () => {
    const row = await client.one(
      insert(db.public.events)
        .values({ id: 1, happened: { iso: "2024-02-29" }, due: { iso: "2024-03-01" } })
        .returning((e) => ({ when: e.happened, id: e.id, due: e.due })),
    );
    expect(row).toStrictEqual({ when: { iso: "2024-02-29" }, id: 1, due: { iso: "2024-03-01" } });

    const raw = await client.all(sql<{ happened: string }>`select happened::text from events`);
    expect(raw).toStrictEqual([{ happened: "2024-02-29" }]);
  });

  it("encodes every row of a multi-row insert", async () => {
    await client.run(
      insert(db.public.events).values([
        { id: 1, happened: { iso: "2024-01-01" } },
        { id: 2, happened: { iso: "2024-01-02" } },
      ]),
    );
    const raw = await client.all(
      sql<{ happened: string }>`select happened::text from events order by id`,
    );
    expect(raw.map((r) => r.happened)).toStrictEqual(["2024-01-01", "2024-01-02"]);
  });

  it("decodes a select of the whole table and of picked, renamed columns", async () => {
    await client.run(insert(db.public.events).values({ id: 1, happened: { iso: "2024-05-06" } }));

    expect(await client.all(from(db.public.events))).toStrictEqual([
      { id: 1, happened: { iso: "2024-05-06" }, due: null, note: null },
    ]);
    const picked = await client.all(
      from(db.public.events).select((e) => ({ at: e.happened, id: e.id })),
    );
    expect(picked).toStrictEqual([{ at: { iso: "2024-05-06" }, id: 1 }]);
    expectTypeOf(picked).toEqualTypeOf<{ at: Day; id: number }[]>();
  });

  it("encodes a predicate value compared against a codec'd column", async () => {
    await client.run(
      insert(db.public.events).values([
        { id: 1, happened: { iso: "2024-01-01" } },
        { id: 2, happened: { iso: "2024-02-01" } },
      ]),
    );
    const query = from(db.public.events)
      .select((e) => ({ id: e.id }))
      .where((e) => e.happened.gt({ iso: "2024-01-15" }));
    expect(query.toSql().params).toStrictEqual(["2024-01-15"]);
    expect(await client.all(query)).toStrictEqual([{ id: 2 }]);
  });

  it("encodes inside and, or, and not", () => {
    const query = from(db.public.events).where((e) =>
      or(
        and(e.happened.eq({ iso: "a" }), e.due.ne({ iso: "b" })),
        not(e.happened.lte({ iso: "c" })),
      ),
    );
    expect(query.toSql().params).toStrictEqual(["a", "b", "c"]);
  });

  it("never passes NULL to a codec, either way", async () => {
    const never: Codec<string, Day> = {
      decode: () => {
        throw new Error("decode saw NULL");
      },
      encode: () => {
        throw new Error("encode saw NULL");
      },
    };
    const t = defineDatabase({
      public: {
        events: defineTable((c) => ({ id: c.integer().primaryKey(), due: c.date().codec(never) })),
      },
    }).public.events;

    const row = await client.one(
      insert(t)
        .values({ id: 1, due: null })
        .returning((e) => ({ due: e.due })),
    );
    expect(row).toStrictEqual({ due: null });
    expect(await client.all(from(t).where((e) => e.due.isNull()))).toStrictEqual([
      { id: 1, due: null },
    ]);
  });

  it("runs no codec for raw sql", async () => {
    await client.run(insert(db.public.events).values({ id: 1, happened: { iso: "2024-02-29" } }));
    const rows = await client.all(sql<{ happened: string }>`select happened::text from events`);
    expect(rows).toStrictEqual([{ happened: "2024-02-29" }]);
  });

  describe("a throwing codec", () => {
    const boom = new Error("boom");
    const bad: Codec<string, Day> = {
      decode: () => {
        throw boom;
      },
      encode: () => {
        throw boom;
      },
    };
    const t = defineDatabase({
      public: {
        events: defineTable((c) => ({ id: c.integer().primaryKey(), due: c.date().codec(bad) })),
      },
    }).public.events;

    it("rejects an insert, naming the table and column", async () => {
      const query = insert(t).values({ id: 1, due: { iso: "2024-01-01" } });
      await expect(client.run(query)).rejects.toThrow(
        'The codec of column "due" of "public"."events" threw while encoding a value',
      );
      await expect(client.run(query)).rejects.toMatchObject({ cause: boom });
    });

    it("rejects a predicate", async () => {
      await expect(
        client.all(from(t).where((e) => e.due.eq({ iso: "2024-01-01" }))),
      ).rejects.toThrow('column "due" of "public"."events" threw while encoding');
    });

    it("rejects a select and an insert returning on decode", async () => {
      await client.run(
        sql`insert into events (id, happened, due) values (1, '2024-01-01', '2024-01-01')`,
      );
      await expect(client.all(from(t))).rejects.toThrow(
        'The codec of column "due" of "public"."events" threw while decoding a value',
      );
      await expect(client.all(from(t).select((e) => ({ x: e.due })))).rejects.toMatchObject({
        cause: boom,
      });
    });

    it("rejects an insert returning on decode", async () => {
      const decodeOnly = defineDatabase({
        public: {
          events: defineTable((c) => ({
            id: c.integer().primaryKey(),
            happened: c.date().codec({
              decode: () => {
                throw boom;
              },
              encode: (v: Day) => v.iso,
            }),
          })),
        },
      }).public.events;
      await expect(
        client.one(
          insert(decodeOnly)
            .values({ id: 2, happened: { iso: "2024-01-01" } })
            .returning((e) => ({ when: e.happened })),
        ),
      ).rejects.toThrow('column "happened" of "public"."events" threw while decoding');
    });
  });
});
