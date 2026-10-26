import { quoteIdentifier } from "../internal/index.ts";
import type { ForeignKeyAction, Columns } from "./column.ts";

/** A foreign key once `defineDatabase` has named its target table. */
export type ForeignKey = {
  /** The name `.references({ name })` gave the constraint; the catalog derives it otherwise. */
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

type Place = { readonly schema: string; readonly table: string; readonly column: string };

/** Every column value of the Database, with each table that holds it. */
export type Places = ReadonlyMap<unknown, readonly Place[]>;

type Tables = Readonly<Record<string, Readonly<Record<string, { readonly columns: Columns }>>>>;

/** Records where each column value lives; `defineDatabase` is the first point where tables have names. */
export function placesOf(schemas: Tables): Places {
  const places = new Map<unknown, Place[]>();
  for (const [schema, tables] of Object.entries(schemas)) {
    for (const [table, { columns }] of Object.entries(tables)) {
      for (const [column, value] of Object.entries(columns)) {
        places.set(value, [...(places.get(value) ?? []), { schema, table, column }]);
      }
    }
  }
  return places;
}

/**
 * The foreign keys the columns of one table declare, in column order. Throws, naming both tables,
 * for a target the Database lacks, a target table rolled up under two names, or a target that is
 * neither a primary key nor unique.
 */
export function foreignKeysOf(
  places: Places,
  schema: string,
  table: string,
  columns: Columns,
): ForeignKey[] {
  const keys: ForeignKey[] = [];
  for (const [name, { state }] of Object.entries(columns)) {
    if (state.references === undefined) continue;
    const { target, options } = state.references;
    const on = `${qualified(schema, table)} (${quoteIdentifier(name)})`;
    const column = target();
    const found = places.get(column) ?? [];
    const [place, other] = found;
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
    if (!column.state.primaryKey && !column.state.unique) {
      throw new Error(
        `the foreign key on ${on} points at ${qualified(place.schema, place.table)} (${quoteIdentifier(place.column)}), which is not a primary key or unique column`,
      );
    }
    keys.push({
      name: options.name,
      columns: [name],
      target: { schema: place.schema, table: place.table, columns: [place.column] },
      onDelete: options.onDelete ?? "no action",
      onUpdate: options.onUpdate ?? "no action",
      match: "simple",
      deferrable: options.deferrable ?? "not deferrable",
    });
  }
  return keys;
}

function qualified(schema: string, table: string): string {
  return [schema, table].map((name) => quoteIdentifier(name)).join(".");
}
