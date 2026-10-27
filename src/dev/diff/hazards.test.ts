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

  it("flags text to an enum, an enum to text, and one enum to another as a rewrite", () => {
    const enums = new Set(["public.mood", "public.feeling"]);
    const rewrite = ["rewrite", "access_exclusive_lock"];

    expect(retypeHazards("text", "public.mood", enums)).toStrictEqual(rewrite);
    expect(retypeHazards("public.mood", "text", enums)).toStrictEqual(rewrite);
    expect(retypeHazards("public.mood", "public.feeling", enums)).toStrictEqual(rewrite);
  });

  it("flags every hazard for an enum and a type other than text or an enum", () => {
    const enums = new Set(["public.mood"]);

    expect(retypeHazards("integer", "public.mood", enums)).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("public.mood", "character varying(5)", enums)).toStrictEqual(HAZARD_KINDS);
  });

  it("flags every hazard for a type it doesn't classify", () => {
    expect(retypeHazards("integer", "citext")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("citext[]", "text[]")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("integer[]", "citext[]")).toStrictEqual(HAZARD_KINDS);
  });
});

describe("retypeHazards for arrays", () => {
  const rewrite = ["rewrite", "access_exclusive_lock"];

  it("rewrites on any element change, even one that widens a length", () => {
    expect(retypeHazards("character varying(20)[]", "character varying(40)[]")).toStrictEqual(
      rewrite,
    );
    expect(retypeHazards("character varying(20)[]", "text[]")).toStrictEqual(rewrite);
    expect(retypeHazards("integer[]", "bigint[]")).toStrictEqual(rewrite);
  });

  it("keeps the element pair's data_loss rule", () => {
    expect(retypeHazards("numeric(10,2)[]", "integer[]")).toStrictEqual(["data_loss", ...rewrite]);
    expect(retypeHazards("timestamp with time zone[]", "date[]")).toContain("data_loss");
    expect(retypeHazards("bigint[]", "integer[]")).not.toContain("data_loss");
  });

  it("reads an enum element, keeping the enum pair's rule", () => {
    const enums = new Set(["public.mood", "public.feeling"]);

    expect(retypeHazards("public.mood[]", "text[]", enums)).toStrictEqual(rewrite);
    expect(retypeHazards("public.mood[]", "public.feeling[]", enums)).toStrictEqual(rewrite);
    expect(retypeHazards("public.mood[]", "integer[]", enums)).toStrictEqual(HAZARD_KINDS);
  });

  it("flags every hazard from a scalar to an array and back", () => {
    expect(retypeHazards("integer", "integer[]")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("integer[]", "integer")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("text", "character varying(5)[]")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("public.mood", "public.mood[]", new Set(["public.mood"]))).toStrictEqual(
      HAZARD_KINDS,
    );
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
    ["numeric", "text", false],
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
    ["real", "real", false],
    ["double precision", "double precision", false],
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
    ["numeric(10,2)", "numeric(10,2)", false],
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
  ["text", "'hello world long value'", "'a'"],
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
  // Both hold the label `a`, so text and each enum convert to the other and back.
  ["public.mood", "'a'", "'a'"],
  ["public.feeling", "'a'", "'a'"],
];
const ENUMS = ["public.mood", "public.feeling"];
// Postgres decides a rewrite by comparing the table's relfilenode before and after, and a lossy
// conversion by converting the column back with a cast and comparing the text. It returns a row
// per sample whose conversion ran, since most pairs have no implicit cast.
const PROBE = `
create function pg_temp.probe_all(types jsonb, enums text[])
returns table(src text, dst text, rewrote boolean, lost boolean) language plpgsql as $f$
declare
  a jsonb; b jsonb; sample text;
  file_before oid; file_after oid; text_before text; text_after text;
  using_clause text; back text;
begin
  create type public.mood as enum ('a', 'b');
  create type public.feeling as enum ('a', 'c');
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
          -- Postgres has no implicit cast to an enum, so the diff writes this USING (ADR-0023).
          using_clause := case when b->>0 = any(enums) then format(' using c::text::%s', b->>0) else '' end;
          execute format('alter table public.probe alter column c type %s%s', b->>0, using_clause);
          select relfilenode into file_after from pg_class where oid = 'public.probe'::regclass;
          src := a->>0; dst := b->>0; rewrote := file_before <> file_after; lost := false;
          begin
            back := case when a->>0 = any(enums) then 'c::text::' else 'c::' end || (a->>0);
            execute format('alter table public.probe alter column c type %s using %s', a->>0, back);
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
  drop type public.mood;
  drop type public.feeling;
end $f$`;

function hazardsOf(row: DriverRow): readonly string[] {
  return retypeHazards(String(row["src"]), String(row["dst"]), new Set(ENUMS));
}

describe("retypeHazards against Postgres 18", () => {
  it("agrees with a real ALTER COLUMN TYPE for every pair of types", async () => {
    const converted = await db.driver.session(async (session) => {
      // timestamp <-> timestamptz skips the rewrite only in a UTC session, which migrations
      // can't count on.
      await session.execute("set timezone = 'America/New_York'");
      await session.execute(PROBE);
      const { rows } = await session.query(
        "select * from pg_temp.probe_all($1::text::jsonb, $2::text[])",
        [JSON.stringify(TYPES), ENUMS],
      );
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

  it("rewrites the table when only an array's element length grows", async () => {
    await db.driver.execute(
      "drop table if exists public.probe; create table public.probe (c character varying(20)[]); insert into public.probe values ('{a,b}')",
    );
    const relfilenode = async (): Promise<unknown> => {
      const { rows } = await db.driver.query(
        "select relfilenode from pg_class where oid = 'public.probe'::regclass",
      );
      return rows[0]?.["relfilenode"];
    };
    const before = await relfilenode();

    await db.driver.execute("alter table public.probe alter column c type character varying(40)[]");

    expect(await relfilenode()).not.toBe(before);
    expect(retypeHazards("character varying(20)[]", "character varying(40)[]")).toContain(
      "rewrite",
    );
    await db.driver.execute("drop table public.probe");
  });
});
