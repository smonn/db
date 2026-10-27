import type { Catalog, Fact, Key } from "../catalog/index.ts";
import type { Action } from "./actions.ts";
import { asideName, enumSwap, enumSwaps } from "./enum-swap.ts";
import type { HandlingTable } from "./handling.ts";
import type { FactOf } from "./statements.ts";

type Catalogs = { readonly from: Catalog; readonly to: Catalog };
type TypeFact = Extract<Fact, { readonly kind: "enum" | "domain" | "domain check" }>;

/**
 * An enum or domain that a table of the same name replaces. A table and a type share one pool of
 * names, so the table can't be created while the type holds the name, and the type can't drop
 * while a column still uses it. The type renames to `aside` first and drops last, as in a swap.
 */
export type Replaced = {
  readonly type: FactOf<"enum" | "domain">;
  readonly aside: string;
};

/** The types `to` replaces with a table, by the key they and the table share. */
export function replacedTypes(catalogs: Catalogs): ReadonlyMap<Key, Replaced> {
  const replaced = new Map<Key, Replaced>();
  const swaps = [...enumSwaps(catalogs).values()];
  for (const [key, type] of catalogs.from) {
    if (type.kind !== "enum" && type.kind !== "domain") continue;
    if (catalogs.to.get(key)?.kind !== "table") continue;
    // Two long names can shorten to one aside, so each also avoids the asides chosen before it.
    const chosen = [
      ...swaps.filter(({ before }) => before.parent === type.parent),
      ...[...replaced.values()].filter((other) => other.type.parent === type.parent),
    ].map((other) => other.aside);
    replaced.set(key, { type, aside: asideName(type, [catalogs.from, catalogs.to], chosen) });
  }
  return replaced;
}

/** The handling of the types a schema holds beside its tables. */
export const TYPE_HANDLING: HandlingTable<TypeFact> = {
  enum: {
    // Postgres refuses to drop a schema that holds a type, so the type drops on its own.
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop enum", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create enum", fact }],
    replacedOnChange: false,
    // An added label is one statement. Postgres can't drop or move one, so a removed or moved
    // label swaps the type, and `column.alter` retypes each column that uses it.
    alter: (before, after, catalogs) => {
      const swap = enumSwap(before, catalogs);
      if (swap !== undefined) {
        return [
          { kind: "rename enum aside", fact: before, swap },
          { kind: "create enum", fact: after },
          { kind: "drop enum aside", fact: before, swap },
        ];
      }
      return after.payload.labels
        .filter((label) => !before.payload.labels.includes(label))
        .map((label) => ({ kind: "add enum value", fact: after, before, label }));
    },
    columnsNamed: () => [],
  },
  domain: {
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop domain", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create domain", fact }],
    replacedOnChange: false,
    // No ALTER DOMAIN changes the base, so this skips a changed one; generate's
    // `refuseTypeChanges` refuses it before the SQL reaches the Shadow.
    alter: (before, after) => {
      const actions: Action[] = [];
      if (before.payload.default !== after.payload.default) {
        actions.push({ kind: "alter domain default", fact: after });
      }
      if (before.payload.notNull !== after.payload.notNull) {
        actions.push({ kind: "alter domain not null", fact: after });
      }
      return actions;
    },
    columnsNamed: () => [],
  },
  // A changed check drops and adds again, since no ALTER DOMAIN changes one.
  "domain check": {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop domain check", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "add domain check", fact }],
    replacedOnChange: true,
    alter: () => [],
    columnsNamed: () => [],
  },
};
