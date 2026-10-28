import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Driver } from "../ports/index.ts";
import { defineDatabase, defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import { createClient, from, insert, type Client, type Query } from "./index.ts";

const testDatabase = useTestDatabase();

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

const at = new Date("2024-02-29T12:34:56.789Z");
const rows = [
  {
    id: 1,
    name: "Ann",
    nick: "annie",
    code: "123e4567-e89b-12d3-a456-426614174000",
    mood: "sad" as const,
    label: "x",
    qty: 5,
    tags: ["a", "b"],
    moods: ["sad" as const],
    meta: ["a"],
    blob: new Uint8Array([0, 1, 255]),
    stamp: at,
  },
  {
    id: 2,
    name: "bob",
    nick: null,
    mood: "ok" as const,
    qty: 7,
    tags: ["c"],
    moods: ["ok" as const, "happy" as const],
  },
  { id: 3, name: "Cy", nick: "cy", label: "y" },
];

const setup =
  "create type public.mood as enum ('sad', 'ok', 'happy'); create domain public.label as text; create domain public.posint as integer; create domain public.blob as bytea; create domain public.doc as jsonb; create domain public.stamp as timestamptz; create table public.items (id integer primary key, name text not null, nick varchar(20), code uuid, mood public.mood, label public.label, qty public.posint, tags text[], moods public.mood[], meta jsonb, blob public.blob, doc public.doc, stamp public.stamp)";

let driver: Driver;
let client: Client;

beforeAll(async () => {
  // One connection, opened before the enum and domains exist (#654).
  driver = testDatabase.ownPool({ max: 1 });
  client = createClient(driver);
  await driver.query("select 1");
  await driver.execute(setup);
  await client.run(insert(db.public.items).values(rows));
  // A scalar object bound to a domain over jsonb fails on any connection ("invalid input syntax
  // for type json"): postgres.js has no serializer for the domain's OID. Outside this probe.
  await driver.execute(`update public.items set doc = '{"n": 1}' where id = 1`);
});

const byId = from(db.public.items)
  .select((u) => ({ id: u.id }))
  .orderBy((u) => u.id);

const ids = async (query: Query<{ id: number }>) => (await client.all(query)).map((row) => row.id);

/** Runs raw SQL on the probe's connection, for ids. */
const run = async (text: string, params: unknown[]) =>
  (await driver.query(text, params)).rows.map((row) => row["id"]);

const castSelect = (column: string, type: string) =>
  `select id from public.items where ${column} = any($1::text[]::public.${type}[]) order by id`;

describe("on Postgres", () => {
  it("orders, with nulls where asked, and pages", async () => {
    const base = from(db.public.items).select((u) => ({ id: u.id }));
    expect(await ids(base.orderBy((u) => u.nick))).toStrictEqual([1, 3, 2]);
    expect(await ids(base.orderBy((u) => u.nick.asc({ nulls: "first" })))).toStrictEqual([2, 1, 3]);
    expect(await ids(base.orderBy((u) => u.nick.desc()))).toStrictEqual([2, 3, 1]);
    expect(
      await ids(
        base
          .orderBy((u) => u.id.desc())
          .limit(1)
          .offset(1),
      ),
    ).toStrictEqual([2]);
    expect(await ids(base.orderBy((u) => u.id).limit(0))).toStrictEqual([]);
  });

  it("matches in and notIn on an enum and domains the connection never fetched", async () => {
    expect(await ids(byId.where((u) => u.mood.in(["sad", "ok"])))).toStrictEqual([1, 2]);
    expect(await ids(byId.where((u) => u.mood.notIn(["sad"])))).toStrictEqual([2]);
    expect(await ids(byId.where((u) => u.label.in(["x", "y"])))).toStrictEqual([1, 3]);
    expect(await ids(byId.where((u) => u.qty.in([5])))).toStrictEqual([1]);
    expect(await ids(byId.where((u) => u.blob.in([new Uint8Array([0, 1, 255])])))).toStrictEqual([
      1,
    ]);
    expect(await ids(byId.where((u) => u.doc.in([{ n: 1 }])))).toStrictEqual([1]);
    expect(await ids(byId.where((u) => u.stamp.in([at])))).toStrictEqual([1]);
  });

  it("matches no row with in([]), but every row with notIn([]), NULL ones too", async () => {
    expect(await ids(byId.where((u) => u.mood.in([])))).toStrictEqual([]);
    // `NULL <> all('{}')` is true, while `NULL <> all('{sad}')` is NULL: row 3's NULL mood
    // matches only the empty list.
    expect(await ids(byId.where((u) => u.mood.notIn([])))).toStrictEqual([1, 2, 3]);
    expect(await ids(byId.where((u) => u.mood.notIn(["happy"])))).toStrictEqual([1, 2]);
  });

  it("matches like and ilike on text, varchar, and a domain over text", async () => {
    expect(await ids(byId.where((u) => u.name.like("A%")))).toStrictEqual([1]);
    expect(await ids(byId.where((u) => u.name.ilike("b%")))).toStrictEqual([2]);
    expect(await ids(byId.where((u) => u.nick.like("%i%")))).toStrictEqual([1]);
    expect(await ids(byId.where((u) => u.label.like("y")))).toStrictEqual([3]);
  });

  it("matches includes on a text array and an enum array", async () => {
    expect(await ids(byId.where((u) => u.tags.includes("c")))).toStrictEqual([2]);
    expect(await ids(byId.where((u) => u.moods.includes("happy")))).toStrictEqual([2]);
  });

  it("decided shape: includes on jsonb<string[]> and in on an array column fail at run time", async () => {
    const base = from(db.public.items).select((u) => ({ id: u.id }));
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return -- the decided shape offered these; Kind hides them. */
    // @ts-expect-error -- hidden by Kind
    const jsonbIncludes = base.where((u) => u.meta.includes("a"));
    // @ts-expect-error -- hidden by Kind
    const arrayIn = base.where((u) => u.tags.in([["a", "b"]]));
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return */
    await expect(client.all(jsonbIncludes)).rejects.toThrow(
      "op ANY/ALL (array) requires array on right side",
    );
    await expect(client.all(arrayIn)).rejects.toThrow(
      "could not find array type for data type text[]",
    );
  });

  it("decided cast: $1::text[]::type[] with a JS array, on the same connection", async () => {
    expect(await run(castSelect("mood", "mood"), [["sad", "ok"]])).toStrictEqual([1, 2]);
    expect(await run(castSelect("qty", "posint"), [[5]])).toStrictEqual([1]);
    expect(await run(castSelect("blob", "blob"), [[new Uint8Array([0, 1, 255])]])).toStrictEqual([
      1,
    ]);
    expect(await run(castSelect("doc", "doc"), [[{ n: 1 }]])).toStrictEqual([1]);
    expect(await run(castSelect("stamp", "stamp"), [[at]])).toStrictEqual([1]);
    // Without the cast, the JS array fails on an enum this connection never fetched.
    await expect(
      run("select id from public.items where mood = any($1)", [["sad"]]),
    ).rejects.toThrow('malformed array literal: "sad"');
  });
});
