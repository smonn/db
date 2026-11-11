import { describe, expect, it } from "vitest";
import type { DriverRow, Queryable } from "../ports/index.ts";
import { trackingSchema } from "./tracking-schema.ts";

type Asked = { readonly text: string; readonly params: readonly unknown[] | undefined };

/** A session that answers each query with the next list of rows, and keeps what it was asked. */
function sessionAnswering(...answers: DriverRow[][]): Queryable & { readonly asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    query(text, params) {
      asked.push({ text, params });
      const rows = answers.shift() ?? [];
      return Promise.resolve({ rows, count: rows.length });
    },
    execute: () => Promise.resolve(),
  };
}

const tracking = trackingSchema("app");

describe("hasMigrationsTable", () => {
  it("asks for the quoted migrations table", async () => {
    const session = sessionAnswering([{ present: true }]);

    expect(await tracking.hasMigrationsTable(session)).toBe(true);
    expect(session.asked).toStrictEqual([
      { text: "select to_regclass($1) is not null as present", params: ['"app"."migrations"'] },
    ]);
  });
});

describe("readCurrent", () => {
  it("reads nothing when the first row holds no text hash", async () => {
    expect(
      await tracking.readCurrent(sessionAnswering([{ present: true }], [{ hash: null }])),
    ).toBe(undefined);
    expect(await tracking.readCurrent(sessionAnswering([{ present: true }], []))).toBeUndefined();
  });
});

describe("hasCurrentTable and isResettable", () => {
  it("answer no when the server returns no row", async () => {
    expect(await tracking.hasCurrentTable(sessionAnswering([]))).toBe(false);
    expect(await tracking.isResettable(sessionAnswering([]))).toBe(false);
  });
});

describe("readUnfinished", () => {
  it("reads a started or failed row, with a missing error as null", async () => {
    const row = { sequence: 3, filename: "000003-x.sql", status: "started" };

    expect(await tracking.readUnfinished(sessionAnswering([row]))).toStrictEqual({
      ...row,
      error: null,
    });
    expect(
      await tracking.readUnfinished(sessionAnswering([{ ...row, error: "boom" }])),
    ).toMatchObject({
      error: "boom",
    });
  });

  it("reads nothing when the last row is applied or there is none", async () => {
    const row = { sequence: 3, filename: "000003-x.sql", status: "applied" };

    expect(await tracking.readUnfinished(sessionAnswering([row]))).toBeUndefined();
    expect(await tracking.readUnfinished(sessionAnswering([]))).toBeUndefined();
  });
});
