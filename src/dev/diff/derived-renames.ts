import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { namesOf, type Catalog, type Fact } from "../catalog/index.ts";
import type { HazardKind } from "./hazards.ts";
import { alterTable, type FactOf } from "./statements.ts";

type Catalogs = { readonly from: Catalog; readonly to: Catalog };

/** The shape of a step in `actions.ts`, which imports this module, so it can't import its type. */
type RenameStep<F> = {
  readonly render: (fact: F, catalogs: Catalogs, action: { readonly was: string }) => string;
  readonly hazards: () => readonly HazardKind[];
};

/** The kind of fact each action acts on. */
export type DerivedTarget = {
  "rename constraint": "primary key" | "unique" | "foreign key";
  "rename index": "index";
  "rename sequence": "identity";
};

/** The name before the rename; the fact is the `to` catalog's, which holds the new one. */
export type DerivedCarries = { readonly [A in keyof DerivedTarget]: { readonly was: string } };

function schemaOf(fact: Fact, catalog: Catalog): string {
  return quoteIdentifier(namesOf(catalog, fact)[0] ?? fact.name);
}

/**
 * The renames of the names a table or column rename leaves stale (ADR-0024). A constraint's,
 * index's, or sequence's name is no API, and each statement only changes the catalog, so none
 * carries a Hazard.
 */
export const DERIVED_STEPS: {
  readonly "rename constraint": RenameStep<FactOf<"primary key" | "unique" | "foreign key">>;
  readonly "rename index": RenameStep<FactOf<"index">>;
  readonly "rename sequence": RenameStep<FactOf<"identity">>;
} = {
  "rename constraint": {
    render: (key, { to }, { was }) =>
      `${alterTable(key, to)} rename constraint ${quoteIdentifier(was)} to ${quoteIdentifier(key.name)};`,
    hazards: () => [],
  },
  "rename index": {
    render: (index, { to }, { was }) =>
      `alter index ${schemaOf(index, to)}.${quoteIdentifier(was)} rename to ${quoteIdentifier(index.name)};`,
    hazards: () => [],
  },
  "rename sequence": {
    render: (identity, { to }, { was }) =>
      `alter sequence ${schemaOf(identity, to)}.${quoteIdentifier(was)} rename to ${quoteIdentifier(identity.payload.sequence)};`,
    hazards: () => [],
  },
};
