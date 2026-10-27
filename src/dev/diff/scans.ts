import { namesOf, parentOf, qualified, type Catalog, type Fact } from "../catalog/index.ts";
import type { Action, ActionKind, Catalogs } from "./actions.ts";

/**
 * Which `pg_depend` walk finds the objects that block an action (ADR-0025): `drop` follows every
 * dependent transitively, `retype` reads the column's direct dependents as `ALTER COLUMN ... TYPE`
 * does, and `none` scans nothing.
 */
type Walk = "drop" | "retype" | "none";

/** One `Walk` per kind of `K`; the test widens `K` to prove a new kind has to name its walk. */
export type ScanTable<K extends string> = { readonly [A in K]: Walk };

/** An object as `pg_get_object_address` takes it, so the scan finds it without parsing names. */
export type ObjectAddress = {
  readonly type: string;
  readonly names: readonly string[];
  readonly args: readonly string[];
};

/** An object the plan drops or retypes, which the scan walks from. */
export type Scan = { readonly walk: Exclude<Walk, "none">; readonly object: ObjectAddress };

/** Defaults, identity, NOT NULL, and expression changes never blocked in #372's fixture. */
export const SCANS: ScanTable<ActionKind> = {
  "rename table": "none",
  "rename column": "none",
  "rename enum": "none",
  "rename enum label": "none",
  "rename domain": "none",
  "rename enum aside": "none",
  "rename domain check": "none",
  "drop foreign key": "drop",
  "drop index": "drop",
  "drop unique": "drop",
  "drop primary key": "drop",
  "drop column": "drop",
  "drop table": "drop",
  "create schema": "none",
  "create enum": "none",
  "add enum value": "none",
  "create domain": "none",
  "drop domain check": "drop",
  "alter domain default": "none",
  "alter domain not null": "none",
  "add domain check": "none",
  "create table": "none",
  "add column": "none",
  "drop default": "none",
  "drop identity": "none",
  "drop expression": "none",
  "alter type": "retype",
  "swap retype": "retype",
  "set not null": "none",
  "drop not null": "none",
  "set default": "none",
  "set expression": "none",
  "add identity": "none",
  "set identity mode": "none",
  "add primary key": "none",
  "add unique": "none",
  "add index": "none",
  "add foreign key": "none",
  "drop domain": "drop",
  "drop enum": "drop",
  "drop enum aside": "drop",
  "drop schema": "drop",
};

/**
 * The objects the actions drop or retype. A drop names its fact in `from`, which is what the
 * Shadow holds, and a retype's column has the same names in both catalogs.
 */
export function scansOf(actions: readonly Action[], { from }: Catalogs): Scan[] {
  return actions.flatMap((action) => {
    const walk = SCANS[action.kind];
    return walk === "none" ? [] : [{ walk, object: addressOf(action.fact, from) }];
  });
}

type Kind = Fact["kind"];
type FactOf<K extends Kind> = Extract<Fact, { readonly kind: K }>;

const tableObject = (fact: Fact, catalog: Catalog): ObjectAddress => ({
  type: "table constraint",
  names: namesOf(catalog, fact),
  args: [],
});

// A column attribute is never a scan's target: its actions all walk `none`.
const attribute = (fact: Fact): never => {
  throw new Error(`No scan walks from a column's ${fact.kind}`);
};

const ADDRESSES: {
  readonly [K in Kind]: (fact: FactOf<K>, catalog: Catalog) => ObjectAddress;
} = {
  schema: (fact) => ({ type: "schema", names: [fact.name], args: [] }),
  table: (fact, catalog) => ({ type: "table", names: namesOf(catalog, fact), args: [] }),
  column: (fact, catalog) => ({ type: "table column", names: namesOf(catalog, fact), args: [] }),
  // A type's name is one SQL-quoted string, as `pg_identify_object_as_address` returns it.
  enum: (fact, catalog) => ({ type: "type", names: [qualified(fact, catalog)], args: [] }),
  domain: (fact, catalog) => ({ type: "type", names: [qualified(fact, catalog)], args: [] }),
  "domain check": (fact, catalog) => ({
    type: "domain constraint",
    names: [qualified(parentOf(catalog, fact), catalog)],
    args: [fact.name],
  }),
  default: attribute,
  identity: attribute,
  generated: attribute,
  "primary key": tableObject,
  unique: tableObject,
  "foreign key": tableObject,
  // An index shares its schema's relation names, so the table drops out of its address.
  index: (fact, catalog) => ({
    type: "index",
    names: [parentOf(catalog, parentOf(catalog, fact)).name, fact.name],
    args: [],
  }),
};

function addressOf<K extends Kind>(fact: FactOf<K>, catalog: Catalog): ObjectAddress {
  return ADDRESSES[fact.kind](fact, catalog);
}
