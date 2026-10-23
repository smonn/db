import { describe, expect, it } from "vitest";
import type { DriverRow } from "../../runtime/ports/index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { HAZARD_KINDS, retypeHazards } from "./hazards.ts";

const db = useTestDatabase();

describe("retypeHazards", () => {
  it("passes a change that only widens a length through", () => {
    expect(retypeHazards("character varying(5)", "character varying(10)")).toStrictEqual([]);
    expect(retypeHazards("character varying(5)", "text")).toStrictEqual([]);
    expect(retypeHazards("numeric(10,2)", "numeric(12,2)")).toStrictEqual([]);
    expect(retypeHazards("numeric(10,2)", "numeric")).toStrictEqual([]);
  });

  it("flags a rewrite and the lock it holds", () => {
    const rewrite = ["rewrite", "access_exclusive_lock"];
    expect(retypeHazards("integer", "bigint")).toStrictEqual(rewrite);
    expect(retypeHazards("text", "character varying(10)")).toStrictEqual(rewrite);
    expect(retypeHazards("character varying(10)", "character varying(5)")).toStrictEqual(rewrite);
    expect(retypeHazards("numeric(10,2)", "numeric(10,4)")).toStrictEqual(rewrite);
    expect(retypeHazards("timestamp without time zone", "timestamp with time zone")).toStrictEqual(
      rewrite,
    );
  });

  it("flags a conversion that rounds or truncates as data loss", () => {
    expect(retypeHazards("numeric(10,2)", "integer")).toStrictEqual([
      "data_loss",
      "rewrite",
      "access_exclusive_lock",
    ]);
    expect(retypeHazards("timestamp with time zone", "date")).toContain("data_loss");
    expect(retypeHazards("double precision", "real")).toContain("data_loss");
    expect(retypeHazards("numeric(10,4)", "numeric(10,2)")).toContain("data_loss");
    expect(retypeHazards("bigint", "double precision")).toContain("data_loss");
  });

  it("doesn't call a conversion that fails on a value that doesn't fit data loss", () => {
    expect(retypeHazards("bigint", "integer")).not.toContain("data_loss");
    expect(retypeHazards("text", "character varying(5)")).not.toContain("data_loss");
    expect(retypeHazards("numeric(12,2)", "numeric(8,2)")).not.toContain("data_loss");
  });

  it("flags every hazard for a type it doesn't classify", () => {
    expect(retypeHazards("integer[]", "bigint[]")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("integer", "citext")).toStrictEqual(HAZARD_KINDS);
  });
});

describe("retypeHazards branches", () => {
  const LOSSY: readonly (readonly [before: string, after: string, loses: boolean])[] = [
    ["smallint", "real", false],
    ["integer", "real", true],
    ["bigint", "real", true],
    ["bigint", "double precision", true],
    ["integer", "double precision", false],
    ["smallint", "double precision", false],
    ["integer", "text", false],
    ["integer", "numeric", false],
    ["numeric(10,0)", "integer", false],
    ["numeric(10,2)", "integer", true],
    ["numeric", "bigint", true],
    ["numeric(6,2)", "real", false],
    ["numeric(7,2)", "real", true],
    ["numeric", "real", true],
    ["numeric(15,2)", "double precision", false],
    ["numeric(16,2)", "double precision", true],
    ["numeric", "double precision", true],
    ["numeric(10,2)", "numeric", false],
    ["numeric", "numeric(10,2)", true],
    ["numeric(10,4)", "numeric(10,2)", true],
    ["numeric(10,2)", "numeric(12,4)", false],
    ["numeric(10,2)", "text", false],
    ["real", "integer", true],
    ["real", "numeric", true],
    ["real", "double precision", false],
    ["double precision", "real", true],
    ["double precision", "bigint", true],
    ["double precision", "numeric(10,2)", true],
    ["real", "text", false],
    ["timestamp without time zone", "date", true],
    ["timestamp with time zone", "date", true],
    ["timestamp without time zone", "timestamp with time zone", false],
    ["date", "timestamp without time zone", false],
    ["text", "integer", false],
  ];

  it.each(LOSSY)("%s to %s loses data: %s", (before, after, loses) => {
    expect(retypeHazards(before, after).includes("data_loss")).toBe(loses);
  });

  const REWRITING: readonly (readonly [before: string, after: string, rewrites: boolean])[] = [
    ["character varying(5)", "text", false],
    ["character varying", "text", false],
    ["character varying(5)", "character varying(10)", false],
    ["character varying(10)", "character varying(5)", true],
    ["character varying(5)", "character varying", false],
    ["character varying", "character varying(5)", true],
    ["character varying(5)", "character varying(5)", false],
    ["character varying(5)", "integer", true],
    ["text", "character varying(10)", true],
    ["text", "character varying", false],
    ["text", "integer", true],
    ["numeric(10,2)", "numeric", false],
    ["numeric", "numeric(10,2)", true],
    ["numeric(10,2)", "numeric(12,2)", false],
    ["numeric(10,2)", "numeric(12,4)", true],
    ["numeric(10,2)", "numeric(8,2)", true],
    ["numeric(10,2)", "text", true],
    ["integer", "bigint", true],
  ];

  it.each(REWRITING)("%s to %s rewrites: %s", (before, after, rewrites) => {
    expect(retypeHazards(before, after).includes("rewrite")).toBe(rewrites);
  });
});

/** A value of each type, and a short one that fits every `varchar(5)`, `numeric(8,2)`, and `smallint`. */
const TYPES: readonly (readonly [type: string, rich: string, short: string])[] = [
  ["text", "'hello world long value'", "'ab'"],
  ["character varying(5)", "'abc'", "'ab'"],
  ["character varying(10)", "'abcdefgh'", "'ab'"],
  ["character varying", "'abcdefgh'", "'ab'"],
  ["smallint", "7", "7"],
  ["integer", "70000", "7"],
  ["bigint", "5000000000", "7"],
  ["numeric", "12.345678", "1.5"],
  ["numeric(10,2)", "12.34", "1.5"],
  ["numeric(12,2)", "12.34", "1.5"],
  ["numeric(10,4)", "12.3456", "1.5"],
  ["numeric(8,2)", "12.34", "1.5"],
  ["real", "1.5", "1.5"],
  ["double precision", "123456789.123456789", "1.5"],
  ["boolean", "true", "true"],
  ["uuid", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'"],
  ["date", "'2020-01-02'", "'2020-01-02'"],
  ["timestamp without time zone", "'2020-01-02 03:04:05.678'", "'2020-01-02 03:04:05.678'"],
  ["timestamp with time zone", "'2020-01-02 03:04:05.678+05'", "'2020-01-02 03:04:05.678+05'"],
  ["jsonb", `'{"a": 1}'`, `'{"a": 1}'`],
  ["bytea", String.raw`'\xdeadbeef'`, String.raw`'\xdeadbeef'`],
];
// Postgres decides a rewrite by comparing the table's relfilenode before and after, and a lossy
// conversion by converting the column back with a cast and comparing the text. It returns a row
// per sample whose conversion ran, since most pairs have no implicit cast.
const PROBE = `
create function pg_temp.probe_all(types jsonb)
returns table(src text, dst text, rewrote boolean, lost boolean) language plpgsql as $f$
declare
  a jsonb; b jsonb; sample text;
  file_before oid; file_after oid; text_before text; text_after text;
begin
  create table public.probe(c int);
  for a in select * from jsonb_array_elements(types) loop
    for b in select * from jsonb_array_elements(types) loop
      continue when a->>0 = b->>0;
      foreach sample in array array[a->>1, a->>2] loop
        begin
          execute format('alter table public.probe alter column c type %s using null', a->>0);
          execute format('insert into public.probe values (%s)', sample);
          select relfilenode into file_before from pg_class where oid = 'public.probe'::regclass;
          execute 'select c::text from public.probe' into text_before;
          execute format('alter table public.probe alter column c type %s', b->>0);
          select relfilenode into file_after from pg_class where oid = 'public.probe'::regclass;
          src := a->>0; dst := b->>0; rewrote := file_before <> file_after; lost := false;
          begin
            execute format('alter table public.probe alter column c type %s using c::%s', a->>0, a->>0);
            execute 'select c::text from public.probe' into text_after;
            lost := text_after is distinct from text_before;
          exception when others then null;
          end;
          return next;
          raise exception 'undo';
        exception when others then null;
        end;
      end loop;
    end loop;
  end loop;
  drop table public.probe;
end $f$`;

function hazardsOf(row: DriverRow): readonly string[] {
  return retypeHazards(String(row["src"]), String(row["dst"]));
}

describe("retypeHazards against Postgres 18", () => {
  it("agrees with a real ALTER COLUMN TYPE for every pair of types", async () => {
    const converted = await db.driver.session(async (session) => {
      // timestamp <-> timestamptz skips the rewrite only in a UTC session, which migrations
      // can't count on.
      await session.execute("set timezone = 'America/New_York'");
      await session.execute(PROBE);
      const { rows } = await session.query("select * from pg_temp.probe_all($1::text::jsonb)", [
        JSON.stringify(TYPES),
      ]);
      return rows;
    });

    const wrongRewrite = converted.filter(
      (row) => row["rewrote"] !== hazardsOf(row).includes("rewrite"),
    );
    const unflaggedLoss = converted
      .filter((row) => row["lost"] === true)
      .filter((row) => !hazardsOf(row).includes("data_loss"));

    expect(wrongRewrite).toStrictEqual([]);
    expect(unflaggedLoss).toStrictEqual([]);
    // Guards against a probe that converts nothing.
    expect(converted.length).toBeGreaterThan(150);
  });
});
