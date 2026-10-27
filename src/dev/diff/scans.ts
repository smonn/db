import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { namesOf, parentOf, qualified, type Catalog, type Fact } from "../catalog/index.ts";
import { render, type Action, type ActionKind, type Catalogs } from "./actions.ts";

/**
 * Which `pg_depend` walk finds the objects that block an action (ADR-0025): `drop` follows every
 * dependent transitively, `retype` reads the column's direct dependents as `ALTER COLUMN ... TYPE`
 * does, `remove` walks nothing but marks a generation expression the plan drops before it retypes,
 * so the retype walk leaves it out, `rename` runs its statement before the walks, so they name
 * what it renames as the plan does, and `none` scans nothing. A declared rename is `none`, since
 * the Shadow runs those before the diff.
 */
type Walk = "drop" | "retype" | "remove" | "rename" | "none";

/** One `Walk` per kind of `K`; the test widens `K` to prove a new kind has to name its walk. */
export type ScanTable<K extends string> = { readonly [A in K]: Walk };

/** An object as `pg_get_object_address` takes it, so the scan finds it without parsing names. */
export type ObjectAddress = {
  readonly type: string;
  readonly names: readonly string[];
  readonly args: readonly string[];
};

/**
 * An object the plan drops, retypes, or removes, which the scan walks from or leaves out, or a
 * rename the scan runs first.
 */
export type Scan =
  | { readonly walk: Exclude<Walk, "rename" | "none">; readonly object: ObjectAddress }
  | { readonly walk: "rename"; readonly sql: string };

/** Defaults, identity, NOT NULL, and expression changes never blocked in #372's fixture. */
export const SCANS: ScanTable<ActionKind> = {
  "rename table": "none",
  "rename column": "none",
  "rename enum": "none",
  "rename enum label": "none",
  "rename domain": "none",
  "rename enum aside": "rename",
  "rename replaced type": "rename",
  "rename domain check": "none",
  "rename constraint": "none",
  "rename index": "none",
  "rename sequence": "none",
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
  "drop expression": "remove",
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
  "drop replaced type": "drop",
  "drop schema": "drop",
};

/**
 * The objects the actions drop, retype, or remove, and the renames to run first. A drop names its
 * fact in `from`, which is what the Shadow holds, and a retype's column has the same names in both
 * catalogs. A swap's old type drops under its aside, which its rename gave it.
 */
export function scansOf(actions: readonly Action[], catalogs: Catalogs): Scan[] {
  return actions.flatMap((action): Scan[] => {
    const walk = SCANS[action.kind];
    if (walk === "none") return [];
    if (walk === "rename") return [{ walk, sql: render(action, catalogs) }];
    const object =
      action.kind === "drop enum aside" || action.kind === "drop replaced type"
        ? asideAddress(action, catalogs.from)
        : addressOf(action.fact, catalogs.from);
    return [{ walk, object }];
  });
}

function asideAddress(
  action: Action<"drop enum aside" | "drop replaced type">,
  from: Catalog,
): ObjectAddress {
  const aside = action.kind === "drop enum aside" ? action.swap.aside : action.aside;
  const schema = parentOf(from, action.fact).name;
  return {
    type: "type",
    names: [`${quoteIdentifier(schema)}.${quoteIdentifier(aside)}`],
    args: [],
  };
}

type Kind = Fact["kind"];
type FactOf<K extends Kind> = Extract<Fact, { readonly kind: K }>;

const tableObject = (fact: Fact, catalog: Catalog): ObjectAddress => ({
  type: "table constraint",
  names: namesOf(catalog, fact),
  args: [],
});

// A default or identity is never a scan's target: its actions all walk `none`.
// Stryker disable next-line BlockStatement: 1 survivor: unreachable, since every action on a default or identity walks `none`.
const attribute = (fact: Fact): never => {
  // Stryker disable next-line StringLiteral: 1 survivor: unreachable, as above.
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
  // `pg_attrdef` holds a generation expression as the column's default value.
  generated: (fact, catalog) => ({
    type: "default value",
    names: namesOf(catalog, parentOf(catalog, fact)),
    args: [],
  }),
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
