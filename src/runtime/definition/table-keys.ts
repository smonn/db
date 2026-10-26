import type { Columns } from "./column.ts";

/** A `Ref` as it exists at runtime; one table's references are told from another's by identity. */
export type RuntimeRefs = Readonly<Record<string, { readonly "~ref": string }>>;

/** A unique constraint over several columns, in key order. */
export type UniqueConstraint = {
  /** The constraint name when the Definition gives one; the catalog derives it otherwise. */
  readonly name: string | undefined;
  readonly columns: readonly string[];
  readonly nullsNotDistinct: boolean;
};

export function refsOf(columns: Columns): RuntimeRefs {
  return Object.fromEntries(Object.keys(columns).map((name) => [name, { "~ref": name }]));
}

/** The column key `ref` names, once it proves to be one of this table's own references. */
function columnOf(own: RuntimeRefs, ref: unknown, entry: string): string {
  const name = typeof ref === "object" && ref !== null && "~ref" in ref ? ref["~ref"] : undefined;
  if (typeof name !== "string") {
    throw new TypeError(`The table's ${entry} names something that is not one of its columns`);
  }
  if (own[name] !== ref) {
    throw new Error(
      `The table's ${entry} takes "${name}" from another table; name columns through the references its own second callback receives`,
    );
  }
  return name;
}

/** The table-level entries that list columns, named as the second callback spells them. */
export type ListingEntry = "primaryKey" | "unique" | "indexes";

/** The column keys of an entry, in order; a key lists two or more, since one goes on the column. An index lists any number. */
export function keyColumns(own: RuntimeRefs, declared: unknown, entry: ListingEntry): string[] {
  const refs: unknown[] = Array.isArray(declared) ? declared : [];
  if (entry !== "indexes" && refs.length < 2) {
    throw new Error(
      `The table's ${entry} lists fewer than two columns; call ${entry}() on the column instead`,
    );
  }
  const keys: string[] = [];
  for (const ref of refs) {
    const name = columnOf(own, ref, entry);
    if (keys.includes(name)) {
      throw new Error(`The table's ${entry} lists "${name}" twice`);
    }
    keys.push(name);
  }
  return keys;
}

const UNIQUE_SHAPE = "The table's unique takes a list of { columns, name?, nullsNotDistinct? }";
const UNIQUE_KEYS = new Set(["columns", "name", "nullsNotDistinct"]);

export function uniquesOf(own: RuntimeRefs, declared: unknown): UniqueConstraint[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new TypeError(UNIQUE_SHAPE);
  const entries: unknown[] = declared;
  return entries.map((entry) => uniqueOf(own, entry));
}

function uniqueOf(own: RuntimeRefs, entry: unknown): UniqueConstraint {
  if (typeof entry !== "object" || entry === null) throw new TypeError(UNIQUE_SHAPE);
  const unexpected = Object.keys(entry).find((key) => !UNIQUE_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`The table's unique does not take "${unexpected}"; ${UNIQUE_SHAPE}`);
  }
  return {
    name: nameOf(entry),
    columns: keyColumns(own, "columns" in entry ? entry.columns : undefined, "unique"),
    nullsNotDistinct: nullsNotDistinctOf(entry),
  };
}

function nameOf(entry: object): string | undefined {
  const name: unknown = "name" in entry ? entry.name : undefined;
  if (name === undefined || typeof name === "string") return name;
  throw new TypeError("The table's unique takes its name as a string");
}

function nullsNotDistinctOf(entry: object): boolean {
  const given: unknown = "nullsNotDistinct" in entry ? entry.nullsNotDistinct : undefined;
  if (given === undefined) return false;
  if (typeof given === "boolean") return given;
  throw new TypeError("The table's unique takes nullsNotDistinct as a boolean");
}
