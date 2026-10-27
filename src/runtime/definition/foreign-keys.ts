import { quoteIdentifier } from "../internal/index.ts";
import type { Columns } from "./column.ts";
import type {
  ColumnReference,
  DeclaredForeignKey,
  ForeignKeyAction,
  KeyPart,
  TableForeignKeyOptions,
} from "./references.ts";
import { columnOf, type RuntimeRefs } from "./table-keys.ts";

/** A foreign key once `defineDatabase` has named its target table. */
export type ForeignKey = {
  /** The name the Definition gave the constraint; the catalog derives it otherwise. */
  readonly name: string | undefined;
  readonly columns: readonly string[];
  readonly target: {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
  };
  readonly onDelete: ForeignKeyAction;
  readonly onUpdate: ForeignKeyAction;
  readonly match: "simple" | "full";
  readonly deferrable: "not deferrable" | "immediate" | "deferred";
};

type Place = {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  /** The table's primary key, which a composite foreign key must point at. */
  readonly primaryKey: readonly string[];
};

export type Places = ReadonlyMap<unknown, readonly Place[]>;

type Tables = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type KeyState = { readonly primaryKey: boolean; readonly unique: boolean };

/** One column of a foreign key's target, with where it lives. */
type Part = { readonly place: Place; readonly state: KeyState };

/** What `foreignKeysOf` reads from the table that holds the foreign keys. */
export type KeyedTable = {
  readonly columns: Columns;
  readonly primaryKey: readonly string[];
  readonly declaredForeignKeys: readonly DeclaredForeignKey[];
};

type Owner = KeyedTable & { readonly schema: string; readonly table: string };

function hasColumns(
  entry: unknown,
): entry is { readonly columns: Columns; readonly primaryKey: readonly string[] } {
  return typeof entry === "object" && entry !== null && "columns" in entry && "primaryKey" in entry;
}

/** Records where each column value lives; `defineDatabase` is the first point where tables have names. */
export function placesOf(schemas: Tables): Places {
  const places = new Map<unknown, Place[]>();
  for (const [schema, tables] of Object.entries(schemas)) {
    for (const [table, entry] of Object.entries(tables)) {
      if (!hasColumns(entry)) continue;
      const { columns, primaryKey } = entry;
      for (const [column, value] of Object.entries(columns)) {
        places.set(value, [...(places.get(value) ?? []), { schema, table, column, primaryKey }]);
      }
    }
  }
  return places;
}

const SHAPE =
  "The table's foreignKeys takes a list of { columns, references, name?, onDelete?, onUpdate?, match?, deferrable? }";
const ENTRY_KEYS = new Set([
  "columns",
  "references",
  "name",
  "onDelete",
  "onUpdate",
  "match",
  "deferrable",
]);

/** The foreign keys the second callback declares, with columns as this table's own column keys. */
export function declaredForeignKeysOf(own: RuntimeRefs, declared: unknown): DeclaredForeignKey[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new TypeError(SHAPE);
  const entries: unknown[] = declared;
  return entries.map((entry) => declaredOf(own, entry));
}

function declaredOf(own: RuntimeRefs, entry: unknown): DeclaredForeignKey {
  const { columns, references, options } = shapeOf(entry);
  return {
    columns: ownColumns(own, columns, "columns"),
    references:
      typeof references === "function"
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types check what the thunk returns; defineDatabase finds each column in the Database.
          (references as () => readonly KeyPart[])
        : ownColumns(own, references, "references"),
    options,
  };
}

function shapeOf(entry: unknown): {
  columns: unknown;
  references: unknown;
  options: TableForeignKeyOptions;
} {
  if (typeof entry !== "object" || entry === null) throw new TypeError(SHAPE);
  const unexpected = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`The table's foreignKeys does not take "${unexpected}"; ${SHAPE}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the keys are checked above; the types check the option values.
  const { columns, references, ...options } = entry as Record<string, unknown> &
    TableForeignKeyOptions;
  return { columns, references, options };
}

function ownColumns(own: RuntimeRefs, listed: unknown, side: "columns" | "references"): string[] {
  const refs: unknown[] = Array.isArray(listed) ? listed : [];
  if (refs.length === 0) {
    throw new Error(`The table's foreignKeys entry lists no ${side}`);
  }
  const keys = refs.map((ref) => columnOf(own, ref, "foreignKeys"));
  const twice = keys.find((key, at) => keys.indexOf(key) !== at);
  if (twice !== undefined) {
    throw new Error(`The table's foreignKeys entry lists "${twice}" twice in its ${side}`);
  }
  return keys;
}

/**
 * The foreign keys of one table, its columns' first, in column order, then the second callback's.
 * Throws, naming both tables, for a target the Database lacks, a target table rolled up under two
 * names, a target that is no key, a column count that differs, or a column that points at its own
 * table.
 */
export function foreignKeysOf(
  places: Places,
  schema: string,
  table: string,
  keyed: KeyedTable,
): ForeignKey[] {
  const owner = { ...keyed, schema, table };
  const keys: ForeignKey[] = [];
  for (const [name, column] of Object.entries(keyed.columns)) {
    const { references } = column.state;
    if (references !== undefined) keys.push(columnForeignKey(places, owner, name, references));
  }
  for (const declared of keyed.declaredForeignKeys) {
    keys.push(declaredForeignKey(places, owner, declared));
  }
  return keys;
}

function columnForeignKey(
  places: Places,
  owner: Owner,
  name: string,
  { target, options }: ColumnReference,
): ForeignKey {
  const on = onTable(owner, [name]);
  const part = partOf(places, on, target());
  if (part.place.schema === owner.schema && part.place.table === owner.table) {
    throw new Error(
      `the foreign key on ${on} points at its own table; declare a self reference in the table's second callback: foreignKeys: [{ columns: [t.${name}], references: [t.${part.place.column}] }]`,
    );
  }
  return foreignKeyOf(on, [name], [part], options);
}

function declaredForeignKey(
  places: Places,
  owner: Owner,
  { columns, references, options }: DeclaredForeignKey,
): ForeignKey {
  const on = onTable(owner, columns);
  const parts =
    typeof references === "function"
      ? partsOf(places, on, references())
      : references.map((column) => ownPart(owner, column));
  return foreignKeyOf(on, columns, parts, options);
}

function ownPart(owner: Owner, column: string): Part {
  const { schema, table, primaryKey } = owner;
  // Stryker disable next-line OptionalChaining: 1 survivor: the column is one of the table's own, which the entry's columnOf checks proved.
  const state = owner.columns[column]?.state;
  return {
    place: { schema, table, column, primaryKey },
    // Stryker disable next-line OptionalChaining: 2 survivors: same column, so `state` is defined.
    state: { primaryKey: state?.primaryKey === true, unique: state?.unique === true },
  };
}

function partOf(places: Places, on: string, target: KeyPart): Part {
  const [place, other] = places.get(target) ?? [];
  if (place === undefined) {
    throw new Error(
      `the foreign key on ${on} points at a table that is not in the Database; add it to defineDatabase`,
    );
  }
  if (other !== undefined) {
    throw new Error(
      `the foreign key on ${on} points at a table that defineDatabase rolls up under two names, ${qualified(place.schema, place.table)} and ${qualified(other.schema, other.table)}; roll it up once`,
    );
  }
  return { place, state: target.state };
}

function partsOf(places: Places, on: string, targets: readonly KeyPart[]): Part[] {
  return targets.map((target) => partOf(places, on, target));
}

function foreignKeyOf(
  on: string,
  columns: readonly string[],
  parts: readonly Part[],
  options: TableForeignKeyOptions,
): ForeignKey {
  return {
    name: options.name,
    columns,
    target: targetOf(on, columns.length, parts),
    onDelete: options.onDelete ?? "no action",
    onUpdate: options.onUpdate ?? "no action",
    match: options.match ?? "simple",
    deferrable: options.deferrable ?? "not deferrable",
  };
}

function targetOf(on: string, count: number, parts: readonly Part[]): ForeignKey["target"] {
  const first = parts.length === count ? parts[0] : undefined;
  if (first === undefined) {
    throw new Error(
      `the foreign key on ${on} lists ${count} column(s) and its target ${parts.length}`,
    );
  }
  const { schema, table } = first.place;
  if (parts.some(({ place }) => place.schema !== schema || place.table !== table)) {
    throw new Error(`the foreign key on ${on} points at columns of more than one table`);
  }
  const columns = parts.map(({ place }) => place.column);
  const missing = keyProblem(first, parts.length, columns);
  if (missing !== undefined) {
    throw new Error(
      `the foreign key on ${on} points at ${qualified(schema, table)} (${columnList(columns)}), which is not ${missing}`,
    );
  }
  return { schema, table, columns };
}

/** What the target lacks to be a key, or undefined: one column must be a key itself, several the primary key. */
function keyProblem(first: Part, count: number, columns: readonly string[]): string | undefined {
  const { schema, table, primaryKey } = first.place;
  if (count === 1) {
    return first.state.primaryKey || first.state.unique
      ? undefined
      : "a primary key or unique column";
  }
  return sameColumns(primaryKey, columns)
    ? undefined
    : `the primary key of ${qualified(schema, table)}`;
}

/** Postgres takes the target's columns in any order, as long as the key covers exactly them. */
function sameColumns(key: readonly string[], columns: readonly string[]): boolean {
  return key.length === columns.length && key.every((column) => columns.includes(column));
}

function onTable({ schema, table }: Owner, columns: readonly string[]): string {
  return `${qualified(schema, table)} (${columnList(columns)})`;
}

function columnList(columns: readonly string[]): string {
  return columns.map((column) => quoteIdentifier(column)).join(", ");
}

function qualified(schema: string, table: string): string {
  return [schema, table].map((name) => quoteIdentifier(name)).join(".");
}
