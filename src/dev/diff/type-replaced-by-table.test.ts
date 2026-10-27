import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";

const db = useTestDatabase();

type Builder = ReturnType<typeof catalogBuilder>;
type Kind = "enum" | "domain" | "table";

/** A `public.thing` of `kind`; a table has the columns `id`, its primary key, and `name`. */
function thing(kind: Kind, extra?: (builder: Builder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  if (kind === "enum") builder.enumType("public", "thing", { labels: ["a", "b"] });
  if (kind === "domain") {
    builder.domain("public", "thing", {
      base: "integer",
      notNull: false,
      default: null,
      defaultVolatile: false,
    });
    builder.domainCheck("public", "thing", "thing_check", { expression: "(VALUE > 0)" });
  }
  if (kind === "table") {
    builder.table("public", "thing");
    builder.column("public", "thing", "id", { type: "text", notNull: true });
    builder.column("public", "thing", "name", { type: "text", notNull: false });
    builder.primaryKey("public", "thing", "thing_pkey", { columns: ["id"] });
  }
  extra?.(builder);
  return builder.build();
}

/** A table `owners` whose column `kind` has `type`. */
const owners =
  (type: string) =>
  (builder: Builder): void => {
    builder.table("public", "owners");
    builder.column("public", "owners", "kind", { type, notNull: false });
  };

/** A table that already takes the name `thing_old`. */
const spare = (builder: Builder): void => {
  builder.table("public", "thing_old");
};

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

async function build(catalog: Catalog): Promise<void> {
  await db.driver.execute(bareDiff(await introspect(db.driver), catalog));
}

describe.each([["enum"], ["domain"]] as const)("a %s replaced by a table of its name", (kind) => {
  it("renames the old type aside, creates the table, and drops the aside", async () => {
    await build(thing(kind));
    const to = thing("table");

    const { sql, hazards } = diff(await introspect(db.driver), to);

    expect(sql.replaceAll(/^-- hazard: \w+\n/gmu, ""))
      .toBe(`alter type "public"."thing" rename to "thing_old";

create table "public"."thing" (
  "id" text not null,
  "name" text
);

alter table "public"."thing" add constraint "thing_pkey" primary key ("id");

drop type "public"."thing_old";
`);
    expect(hazards).toStrictEqual([]);
    await db.driver.execute(sql);
    expect(diff(await introspect(db.driver), to).sql).toBe("");
  });

  it("moves a column off the old type before it drops", async () => {
    await build(thing(kind, owners("public.thing")));
    const to = thing("table", owners("text"));

    const { sql } = diff(await introspect(db.driver), to);
    await db.driver.execute(sql);

    expect(diff(await introspect(db.driver), to).sql).toBe("");
  });

  it("takes the next name when thing_old is taken", async () => {
    await build(thing(kind, spare));
    const to = thing("table", spare);

    const { sql } = diff(await introspect(db.driver), to);
    await db.driver.execute(sql);

    expect(sql).toContain(`rename to "thing_old1"`);
    expect(diff(await introspect(db.driver), to).sql).toBe("");
  });
});

describe("a table replaced by an enum or a domain of its name", () => {
  it.each([
    ["enum", "create type"],
    ["domain", "create domain"],
  ] as const)("drops the table, then creates the %s", async (kind, create) => {
    await build(thing("table"));
    const to = thing(kind);

    const { sql } = diff(await introspect(db.driver), to);

    expect(sql).not.toContain("drop column");
    expect(sql.indexOf("drop table")).toBeLessThan(sql.indexOf(create));
    await db.driver.execute(sql);
    expect(diff(await introspect(db.driver), to).sql).toBe("");
  });
});

/** Enums and tables in schemas; "reordered" holds the labels of "enum" in another order. */
type Entry = readonly [schema: string, name: string, kind: "enum" | "reordered" | "table"];

function entries(...list: readonly Entry[]): Catalog {
  const builder = catalogBuilder();
  for (const name of new Set(list.map(([schema]) => schema))) builder.schema(name);
  for (const [schema, name, kind] of list) {
    if (kind === "table") builder.table(schema, name);
    else builder.enumType(schema, name, { labels: kind === "enum" ? ["a", "b"] : ["b", "a"] });
  }
  return builder.build();
}

// Two names this long shorten to one aside, so the second takes a number.
const LONG = "x".repeat(60);
const ASIDE = `${"x".repeat(59)}_old`;
const NUMBERED = `${"x".repeat(58)}_old1`;

describe("the aside of a replaced type", () => {
  it("avoids the aside another replaced type of its schema took", () => {
    const from = entries(["p", `${LONG}a`, "enum"], ["p", `${LONG}b`, "enum"]);
    const to = entries(["p", `${LONG}a`, "table"], ["p", `${LONG}b`, "table"]);

    const { sql } = diff(from, to);

    expect(sql).toContain(`rename to "${ASIDE}";`);
    expect(sql).toContain(`rename to "${NUMBERED}";`);
  });

  it("avoids the aside a swapped enum of its schema took", () => {
    const from = entries(["p", `${LONG}a`, "enum"], ["p", `${LONG}b`, "enum"]);
    const to = entries(["p", `${LONG}a`, "reordered"], ["p", `${LONG}b`, "table"]);

    const { sql } = diff(from, to);

    expect(sql).toContain(`rename to "${ASIDE}";`);
    expect(sql).toContain(`rename to "${NUMBERED}";`);
  });

  it("ignores the asides of other schemas", () => {
    const from = entries(
      ["p", `${LONG}a`, "enum"],
      ["q", `${LONG}a`, "enum"],
      ["r", `${LONG}b`, "enum"],
      ["s", `${LONG}b`, "enum"],
    );
    const to = entries(
      ["p", `${LONG}a`, "table"],
      ["q", `${LONG}a`, "reordered"],
      ["r", `${LONG}b`, "table"],
      ["s", `${LONG}b`, "table"],
    );

    const { sql } = diff(from, to);

    expect(sql.match(new RegExp(`rename to "${ASIDE}"`, "gu"))).toHaveLength(4);
  });
});
