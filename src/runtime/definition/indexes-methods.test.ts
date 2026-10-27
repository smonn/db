import { describe, expect, it } from "vitest";
import { defineTable } from "./definition.ts";
import type { ColumnFactories } from "./factories.ts";
import type { ColumnRefs } from "./refs.ts";

const columns = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer(), c: c.text() });

type Refs = ColumnRefs<ReturnType<typeof columns>>;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test hands malformed entries to a typed API.
const loose = defineTable as unknown as (
  define: typeof columns,
  extras: (r: Refs) => { indexes: unknown },
) => unknown;

const load = (entry: (r: Refs) => unknown) => () =>
  loose(columns, (r) => ({ indexes: [entry(r)] }));

const hit = (method: string, entry: (r: Refs) => object) =>
  load((r) => ({ method, name: "ix", ...entry(r) }));

const message = (method: string, option: string) =>
  `the index "ix" using the method "${method}", which does not take ${option}`;

describe("an indexes entry by access method", () => {
  it.each(["hash", "gin", "brin", "gist"])("%s refuses desc and non-default nulls", (method) => {
    expect(hit(method, (r) => ({ columns: [{ key: r.a, order: "desc" }] }))).toThrow(
      message(method, 'order "desc"'),
    );
    expect(hit(method, (r) => ({ columns: [{ key: r.a, nulls: "first" }] }))).toThrow(
      message(method, "nulls"),
    );
  });

  it.each(["gin", "brin", "gist"])("%s refuses desc or nulls on one of several keys", (method) => {
    expect(hit(method, (r) => ({ columns: [{ key: r.a, order: "desc" }, r.b] }))).toThrow(
      message(method, 'order "desc"'),
    );
    expect(hit(method, (r) => ({ columns: [{ key: r.a, nulls: "first" }, r.b] }))).toThrow(
      message(method, "nulls"),
    );
  });

  it.each(["hash", "gin", "brin", "gist"])("%s refuses unique", (method) => {
    expect(hit(method, (r) => ({ columns: [r.a], unique: true }))).toThrow(
      message(method, "unique"),
    );
    expect(hit(method, (r) => ({ columns: [r.a], nullsNotDistinct: true }))).toThrow(
      message(method, "nullsNotDistinct"),
    );
  });

  it.each(["hash", "gin", "brin"])("%s refuses include", (method) => {
    expect(hit(method, (r) => ({ columns: [r.a], include: [r.b] }))).toThrow(
      message(method, "include"),
    );
  });

  it("hash refuses more than one column", () => {
    expect(hit("hash", (r) => ({ columns: [r.a, r.b] }))).toThrow(
      message("hash", "more than one column"),
    );
  });

  it("names an unnamed index by its columns", () => {
    expect(load((r) => ({ columns: [r.a, r.b], method: "hash" }))).toThrow(
      'the index on "a", "b" using the method "hash"',
    );
  });

  it.each(["hash", "gin", "brin", "gist"] as const)(
    "%s keeps an explicit asc and the default nulls",
    (method) => {
      expect(
        defineTable(columns, (r) => ({
          indexes: [{ columns: [{ key: r.a, order: "asc", nulls: "last" }], method }],
        })).indexes,
      ).toHaveLength(1);
    },
  );

  it.each(["gin", "brin", "gist"] as const)("%s takes several columns", (method) => {
    expect(
      defineTable(columns, (r) => ({ indexes: [{ columns: [r.a, r.b], method }] })).indexes,
    ).toHaveLength(1);
  });

  it("gist takes include", () => {
    expect(
      defineTable(columns, (r) => ({
        indexes: [{ columns: [r.a], include: [r.b], method: "gist" }],
      })).indexes[0]?.include,
    ).toStrictEqual(["b"]);
  });
});
