import { assert, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineTable,
  plainDate,
  type PlainDate,
  type Row,
} from "../definition/index.ts";
import { createClient, from, insert, sql } from "./index.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const fakeTemporal = {
  PlainDate: {
    from: (text: string): PlainDate => {
      const [year = 0, month = 0, day = 0] = text.split("-").map(Number);
      return {
        year,
        month,
        day,
        toString: () => text,
        equals: (other) => other.toString() === text,
      };
    },
  },
};

const tasks = defineDatabase({
  public: {
    tasks: defineTable((c) => ({
      id: c.integer().primaryKey(),
      due: c.date().codec(plainDate),
    })),
  },
}).public.tasks;

beforeEach(async () => {
  await testDatabase.driver.execute(
    "drop table if exists public.tasks; create table public.tasks (id integer primary key, due date)",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plainDate", () => {
  it("types a date column as PlainDate", () => {
    expectTypeOf<Row<typeof tasks>["due"]>().toEqualTypeOf<PlainDate | null>();
  });

  it("round-trips a date through globalThis.Temporal", async () => {
    vi.stubGlobal("Temporal", fakeTemporal);
    const due = fakeTemporal.PlainDate.from("2024-02-29");

    const row = await client.one(
      insert(tasks)
        .values({ id: 1, due })
        .returning((t) => ({ due: t.due })),
    );

    expect(row.due?.toString()).toBe("2024-02-29");
    expect(row.due?.year).toBe(2024);
    const raw = await client.all(sql<{ due: string }>`select due::text from tasks`);
    expect(raw).toStrictEqual([{ due: "2024-02-29" }]);
  });

  it("reads Temporal when it runs, so a late polyfill works", async () => {
    await client.run(sql`insert into tasks (id, due) values (1, '2024-03-04')`);
    const query = from(tasks);
    vi.stubGlobal("Temporal", fakeTemporal);
    const [row] = await client.all(query);
    expect(row?.due?.toString()).toBe("2024-03-04");
  });

  it("throws when Temporal is missing, naming the table and column through the query", async () => {
    vi.stubGlobal("Temporal", undefined);
    await client.run(sql`insert into tasks (id, due) values (1, '2024-03-04')`);
    const failure = await client.all(from(tasks)).catch((error: unknown) => error);
    assert(failure instanceof Error);
    expect(failure.message).toBe(
      'The codec of column "due" of "public"."tasks" threw while decoding a value',
    );
    expect(String(failure.cause)).toMatch(/needs globalThis\.Temporal/u);
    expect(() => plainDate.decode("2024-01-01")).toThrow(/needs globalThis\.Temporal/u);
  });
});
