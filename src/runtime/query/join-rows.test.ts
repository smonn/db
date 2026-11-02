import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable, type Codec } from "../definition/index.ts";
import { createClient, from, insert } from "./index.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

type Day = { readonly iso: string };
const day: Codec<string, Day> = {
  decode: (base) => ({ iso: base }),
  encode: (value) => value.iso,
};
const shout: Codec<string, string> = {
  decode: (base) => base.toLowerCase(),
  encode: (value) => value.toUpperCase(),
};
const mood = defineEnum(["sad", "ok"]);

const LONG = "ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt";

const db = defineDatabase(
  {
    public: {
      people: defineTable((c) => ({
        id: c.integer().primaryKey(),
        managerId: c.integer(),
        fullName: c.text().codec(shout).notNull().name("FullName"),
        born: c.date().codec(day),
      })),
      notes: defineTable((c) => ({
        id: c.integer().primaryKey(),
        personId: c.integer().notNull(),
        body: c.text().codec(shout).name("Body"),
        due: c.date().codec(day),
        moods: c.enum(mood).array(),
      })),
    },
  },
  { casing: "snake_case" },
);
const { people, notes } = db.public;
const long = defineDatabase({ public: { [LONG]: defineTable((c) => ({ id: c.integer() })) } })
  .public[LONG];

// An enum created per test would leave the driver's cached statements naming a dropped type.
beforeAll(async () => {
  await testDatabase.driver.execute(`
    drop table if exists public.people, public.notes, public.${LONG};
    drop type if exists public.mood;
    create type public.mood as enum ('sad', 'ok');
    create table public.people (id integer primary key, manager_id integer, "FullName" text not null, born date);
    create table public.notes (id integer primary key, person_id integer not null, "Body" text, due date, moods public.mood[]);
    create table public.${LONG} (id integer);
  `);
});

beforeEach(async () => {
  await testDatabase.driver.execute(`truncate public.people, public.notes, public.${LONG}`);
  await client.run(
    insert(people).valuesMany([
      { id: 1, fullName: "ann", born: { iso: "1980-01-02" } },
      { id: 2, managerId: 1, fullName: "bob" },
      { id: 3, managerId: 2, fullName: "cy", born: { iso: "1999-03-04" } },
    ]),
  );
  await client.run(
    insert(notes).valuesMany([
      { id: 10, personId: 2, body: "hello", due: { iso: "2026-01-01" }, moods: ["ok", "sad"] },
      { id: 11, personId: 3, body: null },
    ]),
  );
});

describe("joins on Postgres", () => {
  it("joins a table to itself, decoding each side through its own codecs", async () => {
    const rows = await client.all(
      from(people)
        .innerJoin(people, (worker, boss) => boss.id.eq(worker.managerId))
        .orderBy((worker) => worker.id)
        .select((worker, boss) => ({
          worker: worker.fullName,
          boss: boss.fullName,
          born: boss.born,
        })),
    );
    expect(rows).toStrictEqual([
      { worker: "bob", boss: "ann", born: { iso: "1980-01-02" } },
      { worker: "cy", boss: "bob", born: null },
    ]);
  });

  it("reads NULL for a left join with no match, and runs no decoder on it", async () => {
    const rows = await client.all(
      from(people)
        .leftJoin(notes, (p, n) => n.personId.eq(p.id))
        .orderBy((p) => p.id)
        .select((p, n) => ({ name: p.fullName, body: n.body, due: n.due, moods: n.moods })),
    );
    expect(rows).toStrictEqual([
      { name: "ann", body: null, due: null, moods: null },
      { name: "bob", body: "hello", due: { iso: "2026-01-01" }, moods: ["ok", "sad"] },
      { name: "cy", body: null, due: null, moods: null },
    ]);
  });

  it("chains an inner and a left join, filtering by a where written before them", async () => {
    const rows = await client.all(
      from(people)
        .where((p) => p.id.gt(1))
        .innerJoin(notes, (p, n) => n.personId.eq(p.id))
        .leftJoin(people, (p, _n, boss) => boss.id.eq(p.managerId))
        .where((_p, n) => n.body.isNotNull())
        .select((p, n, boss) => ({ name: p.fullName, body: n.body, boss: boss.fullName })),
    );
    expect(rows).toStrictEqual([{ name: "bob", body: "hello", boss: "ann" }]);
  });

  it("binds a value through its codec and compares a column operand as stored", async () => {
    const rows = await client.all(
      from(people)
        .innerJoin(notes, (p, n) => n.body.ne(p.fullName))
        .where((p) => p.fullName.eq("bob"))
        .select((_p, n) => ({ id: n.id })),
    );
    expect(rows).toStrictEqual([{ id: 10 }]);
  });

  it("self-joins a table whose name is 63 bytes", async () => {
    await testDatabase.driver.execute(`insert into public.${LONG} (id) values (1), (2)`);
    const rows = await client.all(
      from(long)
        .innerJoin(long, (a, b) => b.id.gt(a.id))
        .select((a, b) => ({ a: a.id, b: b.id })),
    );
    expect(rows).toStrictEqual([{ a: 1, b: 2 }]);
  });
});
