import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type Fact, type Key } from "../catalog/index.ts";
import { HANDLING } from "./diff.ts";
import type { Handling, HandlingTable } from "./handling.ts";

/** A kind the diff doesn't know yet, such as a view. */
type View = {
  readonly kind: "view";
  readonly name: string;
  readonly parent: Key;
  readonly payload: { readonly columns: readonly string[] };
};
type Future = Fact | View;

const stated: Handling<View> = {
  parentDropCovers: true,
  drop: () => [],
  parentCreateCovers: false,
  create: () => [],
  replacedOnChange: true,
  alter: () => [],
  columnsNamed: (fact) => fact.payload.columns,
};

describe("the handling of each fact kind", () => {
  it("fails to compile until a new kind states every decision", () => {
    const complete: HandlingTable<Future> = { ...HANDLING, view: stated };

    // @ts-expect-error -- no handling at all for the new kind.
    const none: HandlingTable<Future> = { ...HANDLING };

    // @ts-expect-error -- no statement of whether a dropped parent covers its drop.
    const noDrop: HandlingTable<Future> = { ...HANDLING, view: omit(stated, "parentDropCovers") };

    const noCreate: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of whether a new parent creates it inline.
      view: omit(stated, "parentCreateCovers"),
    };

    // @ts-expect-error -- no altered comparison.
    const noAlter: HandlingTable<Future> = { ...HANDLING, view: omit(stated, "alter") };

    const noReplaced: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of whether a changed payload replaces it.
      view: omit(stated, "replacedOnChange"),
    };

    const noColumns: HandlingTable<Future> = {
      ...HANDLING,
      // @ts-expect-error -- no statement of which columns it names, so a rebuilt one drops it.
      view: omit(stated, "columnsNamed"),
    };

    expect([complete, none, noDrop, noCreate, noAlter, noReplaced, noColumns]).toHaveLength(7);
  });
});

const isKind = <K extends Fact["kind"]>(
  fact: Fact,
  kind: K,
): fact is Extract<Fact, { readonly kind: K }> => fact.kind === kind;

/** The first fact of `kind` in a catalog that holds one of each. */
function first<K extends Fact["kind"]>(catalog: Catalog, kind: K): Extract<Fact, { kind: K }> {
  const found = [...catalog.values()].find((fact) => isKind(fact, kind));
  if (found === undefined || !isKind(found, kind)) throw new Error(`no ${kind} fact`);
  return found;
}

const everyKind: Catalog = (() => {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.enumType("public", "mood", { labels: ["a"] });
  builder.domain("public", "code", {
    base: "text",
    default: null,
    defaultVolatile: false,
    notNull: false,
  });
  builder.domainCheck("public", "code", "short", { expression: "length(VALUE) < 9" });
  builder.table("public", "t");
  builder.column("public", "t", "c", { type: "integer", notNull: false });
  builder.columnDefault("public", "t", "c", { expression: "1", volatile: false });
  builder.columnIdentity("public", "t", "c", { generated: "always" });
  builder.columnGenerated("public", "t", "c", { expression: "(1)", storage: "stored" });
  return builder.build();
})();

describe("what the diff does with each fact kind", () => {
  it("covers a child's drop or create with its parent's, and replaces what can't alter", () => {
    const flags = Object.entries(HANDLING).map(([kind, handling]) => [
      kind,
      handling.parentDropCovers,
      handling.parentCreateCovers,
      handling.replacedOnChange,
    ]);

    expect(flags).toStrictEqual([
      ["schema", false, false, false],
      ["enum", false, false, false],
      ["domain", false, false, false],
      ["domain check", true, true, true],
      ["table", false, false, false],
      ["column", true, true, false],
      ["default", true, true, false],
      ["identity", true, true, false],
      ["generated", true, true, false],
      ["primary key", true, false, true],
      ["unique", true, false, true],
      ["index", true, false, true],
      ["foreign key", false, false, true],
    ]);
  });

  it("names no column of its table for a kind that isn't a constraint on columns", () => {
    expect(HANDLING.schema.columnsNamed(first(everyKind, "schema"))).toStrictEqual([]);
    expect(HANDLING.table.columnsNamed(first(everyKind, "table"))).toStrictEqual([]);
    expect(HANDLING.column.columnsNamed(first(everyKind, "column"))).toStrictEqual([]);
    expect(HANDLING.default.columnsNamed(first(everyKind, "default"))).toStrictEqual([]);
    expect(HANDLING.identity.columnsNamed(first(everyKind, "identity"))).toStrictEqual([]);
    expect(HANDLING.generated.columnsNamed(first(everyKind, "generated"))).toStrictEqual([]);
    expect(HANDLING.enum.columnsNamed(first(everyKind, "enum"))).toStrictEqual([]);
    expect(HANDLING.domain.columnsNamed(first(everyKind, "domain"))).toStrictEqual([]);
    expect(HANDLING["domain check"].columnsNamed(first(everyKind, "domain check"))).toStrictEqual(
      [],
    );
  });

  it("creates no action for a generated fact, which only a rebuilt column adds", () => {
    expect(HANDLING.generated.create(first(everyKind, "generated"))).toStrictEqual([]);
  });
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}
