import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineDatabase, defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import { createClient, from, insert } from "./index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const labels = [
  "plain",
  "a,b",
  'q"uote',
  String.raw`back\slash`,
  "NULL",
  "{x}",
  "two words",
] as const;
const mood = defineEnum(labels);
const domains = {
  domtext: defineDomain((c) => c.text()),
  domvarchar: defineDomain((c) => c.varchar(20)),
  domsmallint: defineDomain((c) => c.smallint()),
  dominteger: defineDomain((c) => c.integer()),
  dombigint: defineDomain((c) => c.bigint()),
  domnumeric: defineDomain((c) => c.numeric()),
  domreal: defineDomain((c) => c.real()),
  domdouble: defineDomain((c) => c.doublePrecision()),
  domboolean: defineDomain((c) => c.boolean()),
  domuuid: defineDomain((c) => c.uuid()),
  domdate: defineDomain((c) => c.date()),
  domtimestamp: defineDomain((c) => c.timestamp()),
  domtimestamptz: defineDomain((c) => c.timestamptz()),
  domjsonb: defineDomain((c) => c.jsonb<{ n: number } | string>()),
  dombytea: defineDomain((c) => c.bytea()),
  dommood: defineDomain((c) => c.enum(mood)),
};

const t = defineTable((c) => ({
  id: c.integer().notNull(),
  mood: c.enum(mood).array(),
  domtext: c.domain(domains.domtext).array(),
  domvarchar: c.domain(domains.domvarchar).array(),
  domsmallint: c.domain(domains.domsmallint).array(),
  dominteger: c.domain(domains.dominteger).array(),
  dombigint: c.domain(domains.dombigint).array(),
  domnumeric: c.domain(domains.domnumeric).array(),
  domreal: c.domain(domains.domreal).array(),
  domdouble: c.domain(domains.domdouble).array(),
  domboolean: c.domain(domains.domboolean).array(),
  domuuid: c.domain(domains.domuuid).array(),
  domdate: c.domain(domains.domdate).array(),
  domtimestamp: c.domain(domains.domtimestamp).array(),
  domtimestamptz: c.domain(domains.domtimestamptz).array(),
  domjsonb: c.domain(domains.domjsonb).array(),
  dombytea: c.domain(domains.dombytea).array(),
  dommood: c.domain(domains.dommood).array(),
}));
const db = defineDatabase({ public: { mood, ...domains, t } });

const bases = [
  "text",
  "varchar(20)",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "boolean",
  "uuid",
  "date",
  "timestamp",
  "timestamptz",
  "jsonb",
  "bytea",
  "mood",
];
const domainNames = Object.keys(domains);
const columns = ["mood", ...domainNames];

const setup = [
  "drop table if exists public.t",
  ...domainNames.map((name) => `drop domain if exists public.${name}`),
  "drop type if exists public.mood",
  `create type public.mood as enum (${labels.map((label) => `'${label.replaceAll("'", "''")}'`).join(", ")})`,
  ...domainNames.map((name, at) => `create domain public.${name} as ${bases[at]}`),
  `create table public.t (id integer not null, ${columns.map((name) => `"${name}" public.${name === "mood" ? "mood" : name}[]`).join(", ")})`,
].join("; ");

const at = new Date("2024-02-29T12:34:56.789Z");

// Each array holds a NULL element, and where the type allows it, text that reads like NULL, a
// delimiter, or a quote.
const filled = {
  id: 1,
  mood: [...labels, null],
  domtext: ["NULL", null, 'a,"b"\\', "", "{x}"],
  domvarchar: ["{x}", null],
  domsmallint: [-32768, null],
  dominteger: [2147483647, null],
  dombigint: [9007199254740993n, null],
  domnumeric: ["12345678901234567890.123456789", null],
  domreal: [1.5, null],
  domdouble: [0.1, null],
  domboolean: [true, false, null],
  domuuid: ["123e4567-e89b-12d3-a456-426614174000", null],
  domdate: ["2024-02-29", null],
  domtimestamp: [at, null],
  domtimestamptz: [at, null],
  domjsonb: [{ n: 1 }, null, "s"],
  dombytea: [new Uint8Array([0, 1, 254, 255]), null],
  dommood: ["a,b", "NULL", null],
};

const empty = { id: 2, ...Object.fromEntries(columns.map((name) => [name, []])) };

beforeAll(async () => {
  // The connection is already open, so these types are new to it. Created once, because
  // postgres.js caches prepared statements by their text and a dropped type would break them.
  await testDatabase.driver.execute(setup);
});

beforeEach(async () => {
  await testDatabase.driver.execute("truncate public.t");
});

describe("enum and domain arrays through the query builder", () => {
  it("round-trips every base kind, quoted labels, NULL elements, and empty arrays", async () => {
    await client.run(insert(db.public.t).values([filled, empty]));

    const rows = await client.all(from(db.public.t));

    expect(rows).toStrictEqual([filled, empty]);
  });

  it("reads a NULL column as null and keeps a selected key as the column's name", async () => {
    await client.run(insert(db.public.t).values({ id: 3 }));
    await client.run(insert(db.public.t).values(filled));

    const rows = await client.all(
      from(db.public.t)
        .select((r) => ({ labels: r.mood, sizes: r.dombigint }))
        .where((r) => r.id.eq(3)),
    );

    expect(rows).toStrictEqual([{ labels: null, sizes: null }]);
  });

  it("casts each enum and domain array column to text and leaves others alone", () => {
    const { text } = from(db.public.t)
      .select((r) => ({ id: r.id, labels: r.mood, sizes: r.dominteger }))
      .toSql();

    expect(text).toBe(
      'select "id", "mood"::text as "labels", "dominteger"::text as "sizes" from "public"."t"',
    );
  });

  it("decodes returning", async () => {
    const rows = await client.all(
      insert(db.public.t)
        .values(filled)
        .returning((r) => ({ mood: r.mood, dommood: r.dommood, dombytea: r.dombytea })),
    );

    expect(rows).toStrictEqual([
      { mood: filled.mood, dommood: filled.dommood, dombytea: filled.dombytea },
    ]);
  });

  it("matches an enum or domain array in a predicate", async () => {
    await client.run(insert(db.public.t).values([filled, empty]));

    const rows = await client.all(
      from(db.public.t)
        .select((r) => ({ id: r.id }))
        .where((r) => r.mood.eq(filled.mood))
        .where((r) => r.dommood.eq(["a,b", "NULL", null]))
        .where((r) => r.dombigint.ne([1n])),
    );

    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("reads the same through a connection that fetched these types when it opened", async () => {
    await client.run(insert(db.public.t).values(filled));
    const fresh = createClient(testDatabase.ownPool({ max: 1 }));

    const rows = await fresh.all(from(db.public.t));

    expect(rows).toStrictEqual([filled]);
  });

  it("runs an enum column's codec on each element once the array is read", async () => {
    const counted = defineTable((c) => ({
      mood: c
        .enum(mood)
        .codec<number>({
          decode: (label) => label.length,
          encode: () => "plain",
        })
        .array(),
    }));
    const countedDb = defineDatabase({ public: { mood, t: counted } });
    await client.run(insert(db.public.t).values(filled));

    const rows = await client.all(from(countedDb.public.t));

    expect(rows).toStrictEqual([{ mood: [...labels.map((label) => label.length), null] }]);
  });

  it("names the column when stored text isn't an array", async () => {
    const broken = defineTable((c) => ({ v: c.enum(mood).array() }));
    const brokenDb = defineDatabase({ public: { mood, broken } });
    await testDatabase.driver.execute(
      "create table if not exists public.broken (v text); insert into public.broken values ('{unclosed')",
    );

    await expect(client.all(from(brokenDb.public.broken))).rejects.toThrow(
      `Can't read the array in column "v" of "public"."broken"`,
    );
  });
});
