import { describe, expect, it } from "vitest";
import { defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import { assertComparable } from "./comparable.ts";

const mood = defineEnum(["sad", "ok"]);
const twin = defineEnum(["sad", "ok"]);
const moodDomain = defineDomain((c) => c.enum(mood));
const textDomain = defineDomain((c) => c.text());
const { columns } = defineTable((c) => ({
  mood: c.enum(mood),
  twin: c.enum(twin),
  moodDomain: c.domain(moodDomain),
  moods: c.enum(mood).array(),
  twins: c.enum(twin).array(),
  integer: c.integer(),
  numeric: c.numeric(10, 2),
  integers: c.integer().array(),
  bigints: c.bigint().array(),
  text: c.text(),
  texts: c.text().array(),
  varchars: c.varchar(10).array(),
  longVarchars: c.varchar(20).array(),
  textDomain: c.domain(textDomain),
  textDomains: c.domain(textDomain).array(),
}));

type Key = keyof typeof columns;

const compare = (left: Key, right: Key) => () => {
  assertComparable(
    { alias: "t", column: left, state: columns[left].state },
    { alias: "u", column: right, state: columns[right].state },
  );
};

describe("assertComparable", () => {
  it("passes the pairs Postgres compares", () => {
    expect(compare("mood", "mood")).not.toThrow();
    expect(compare("moods", "moods")).not.toThrow();
    expect(compare("integer", "numeric")).not.toThrow();
    expect(compare("text", "textDomain")).not.toThrow();
    expect(compare("varchars", "longVarchars")).not.toThrow();
    expect(compare("moodDomain", "moodDomain")).not.toThrow();
  });

  it("refuses an enum, a domain over one, or an array against any other type, naming both", () => {
    expect(compare("mood", "twin")).toThrow(
      'Can\'t compare "t"."mood" with "u"."twin": Postgres compares an enum, a domain over one, or an array only with the identical type',
    );
    expect(compare("moodDomain", "mood")).toThrow(
      'Can\'t compare "t"."moodDomain" with "u"."mood"',
    );
    expect(compare("mood", "moodDomain")).toThrow(
      'Can\'t compare "t"."mood" with "u"."moodDomain"',
    );
    expect(compare("moods", "twins")).toThrow('Can\'t compare "t"."moods" with "u"."twins"');
    expect(compare("integers", "bigints")).toThrow(
      'Can\'t compare "t"."integers" with "u"."bigints"',
    );
    expect(compare("texts", "varchars")).toThrow('Can\'t compare "t"."texts" with "u"."varchars"');
    expect(compare("texts", "textDomains")).toThrow(
      'Can\'t compare "t"."texts" with "u"."textDomains"',
    );
    expect(compare("moods", "mood")).toThrow('Can\'t compare "t"."moods" with "u"."mood"');
    expect(compare("text", "texts")).toThrow('Can\'t compare "t"."text" with "u"."texts"');
  });
});
