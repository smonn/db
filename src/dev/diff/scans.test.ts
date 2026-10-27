import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import type { ActionKind } from "./actions.ts";
import { diff } from "./diff.ts";
import { SCANS, type ScanTable } from "./scans.ts";

/** A kind the diff doesn't have yet, such as a view drop. */
type Future = ActionKind | "drop view";

const text = { type: "text", notNull: false };
const code = { base: "text", default: null, defaultVolatile: false, notNull: false };

function catalog(build: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  build(builder);
  return builder.build();
}

/** `app.mood` holding `labels`, and a table with a column of it. */
const withMood = (labels: readonly string[]): Catalog =>
  catalog((b) => {
    b.enumType("app", "mood", { labels });
    b.table("app", "t");
    b.column("app", "t", "m", { type: "app.mood", notNull: false });
  });

const kindsOf = (walk: string): string[] =>
  Object.entries(SCANS)
    .filter(([, found]) => found === walk)
    .map(([kind]) => kind);

describe("the scan of each action kind", () => {
  it("fails to compile until a new kind names its walk", () => {
    const complete: ScanTable<Future> = { ...SCANS, "drop view": "drop" };

    // @ts-expect-error -- no walk for the new kind.
    const none: ScanTable<Future> = { ...SCANS };

    // @ts-expect-error -- a walk the scan doesn't have.
    const unlisted: ScanTable<Future> = { ...SCANS, "drop view": "cascade" };

    expect([complete, none, unlisted]).toHaveLength(3);
  });

  it("addresses each dropped or retyped object as pg_get_object_address takes it", () => {
    const from = catalog((b) => {
      b.table("app", "users.x");
      b.column("app", "users.x", "id", text);
      b.column("app", "users.x", "email", text);
      b.columnDefault("app", "users.x", "email", { expression: "'x'::text", volatile: false });
      b.column("app", "users.x", "upper", text);
      b.columnGenerated("app", "users.x", "upper", {
        expression: "upper(email)",
        storage: "stored",
      });
      b.unique("app", "users.x", "users_email_key", {
        columns: ["email"],
        nullsNotDistinct: false,
      });
      b.index("app", "users.x", "users_id_idx", {
        unique: false,
        method: "btree",
        keys: [{ column: "id", descending: false, nullsFirst: false }],
        include: [],
        where: undefined,
        nullsNotDistinct: false,
      });
      b.domain("app", "code", code);
      b.domainCheck("app", "code", "short", { expression: "length(VALUE) < 9" });
      b.table("app", "gone");
    });
    const to = catalog((b) => {
      b.table("app", "users.x");
      b.column("app", "users.x", "id", { type: "integer", notNull: false });
      b.column("app", "users.x", "email", { type: "text", notNull: true });
      b.column("app", "users.x", "upper", text);
      b.domain("app", "code", code);
    });

    expect(diff(from, to).scans).toStrictEqual([
      { walk: "drop", object: { type: "index", names: ["app", "users_id_idx"], args: [] } },
      {
        walk: "drop",
        object: {
          type: "table constraint",
          names: ["app", "users.x", "users_email_key"],
          args: [],
        },
      },
      { walk: "drop", object: { type: "table", names: ["app", "gone"], args: [] } },
      {
        walk: "drop",
        object: { type: "domain constraint", names: [`"app"."code"`], args: ["short"] },
      },
      {
        walk: "remove",
        object: { type: "default value", names: ["app", "users.x", "upper"], args: [] },
      },
      {
        walk: "retype",
        object: { type: "table column", names: ["app", "users.x", "id"], args: [] },
      },
    ]);
  });

  it("sorts each action kind into the walk ADR-0025 gives it", () => {
    expect(kindsOf("drop")).toStrictEqual([
      "drop foreign key",
      "drop index",
      "drop unique",
      "drop primary key",
      "drop column",
      "drop table",
      "drop domain check",
      "drop domain",
      "drop enum",
      "drop enum aside",
      "drop replaced type",
      "drop schema",
    ]);
    expect(kindsOf("retype")).toStrictEqual(["alter type", "swap retype"]);
    expect(kindsOf("remove")).toStrictEqual(["drop expression"]);
    expect(kindsOf("rename")).toStrictEqual(["rename enum aside", "rename replaced type"]);
    expect(kindsOf("none")).toStrictEqual([
      "rename table",
      "rename column",
      "rename enum",
      "rename enum label",
      "rename domain",
      "rename domain check",
      "rename constraint",
      "rename index",
      "rename sequence",
      "create schema",
      "create enum",
      "add enum value",
      "create domain",
      "alter domain default",
      "alter domain not null",
      "add domain check",
      "create table",
      "add column",
      "drop default",
      "drop identity",
      "set not null",
      "drop not null",
      "set default",
      "set expression",
      "add identity",
      "set identity mode",
      "add primary key",
      "add unique",
      "add index",
      "add foreign key",
    ]);
  });

  it("addresses a dropped schema, enum, and domain", () => {
    const from = catalog((b) => {
      b.schema("gone");
      b.enumType("app", "mood", { labels: ["a"] });
      b.domain("app", "code", code);
    });

    expect(
      diff(
        from,
        catalog(() => {}),
      ).scans,
    ).toStrictEqual([
      { walk: "drop", object: { type: "type", names: [`"app"."code"`], args: [] } },
      { walk: "drop", object: { type: "type", names: [`"app"."mood"`], args: [] } },
      { walk: "drop", object: { type: "schema", names: ["gone"], args: [] } },
    ]);
  });

  it("runs a swap's rename aside first and drops the old type under the aside", () => {
    expect(diff(withMood(["a", "b"]), withMood(["b", "a"])).scans).toStrictEqual([
      { walk: "rename", sql: 'alter type "app"."mood" rename to "mood_old";' },
      { walk: "retype", object: { type: "table column", names: ["app", "t", "m"], args: [] } },
      { walk: "drop", object: { type: "type", names: [`"app"."mood_old"`], args: [] } },
    ]);
  });

  it("runs the rename aside of a type a table replaces first and drops it under the aside", () => {
    const table = catalog((b) => {
      b.table("app", "mood");
    });

    expect(diff(withMood(["a"]), table).scans).toStrictEqual([
      { walk: "rename", sql: 'alter type "app"."mood" rename to "mood_old";' },
      { walk: "drop", object: { type: "table", names: ["app", "t"], args: [] } },
      { walk: "drop", object: { type: "type", names: [`"app"."mood_old"`], args: [] } },
    ]);
  });
});
