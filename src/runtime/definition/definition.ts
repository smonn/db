import type { Columns } from "./column.ts";
import { type ColumnFactories, factories } from "./factories.ts";
import { declaredForeignKeysOf } from "./foreign-keys.ts";
import { indexesOf } from "./indexes.ts";
import type { ColumnRefs } from "./refs.ts";
import type { ExtrasArgs, KeyOf } from "./table-extras.ts";
import { keyColumns, refsOf, type RuntimeRefs, uniquesOf } from "./table-keys.ts";
import type { TableDefinition } from "./table.ts";

type PrimaryKey = { readonly columns: string[]; readonly name: string | undefined };

function primaryKeyOf(columns: Columns, own: RuntimeRefs, declared: unknown): PrimaryKey {
  const single = Object.entries(columns).filter(([, { state }]) => state.primaryKey);
  if (declared === undefined) {
    if (single.length > 1) {
      throw new Error(
        `Columns ${single.map(([n]) => `"${n}"`).join(", ")} each call primaryKey(); declare a composite key in the table's second callback instead`,
      );
    }
    return { columns: single.map(([n]) => n), name: single[0]?.[1].state.constraintName };
  }
  if (single.length > 0) {
    throw new Error(
      `Column "${single[0]?.[0]}" calls primaryKey() and the table's second callback also declares a primary key; use one`,
    );
  }
  const entry = keyEntry(declared);
  return { columns: keyColumns(own, entry.columns, "primaryKey"), name: entry.name };
}

function keyEntry(declared: unknown): { name: string | undefined; columns: unknown } {
  if (Array.isArray(declared)) return { name: undefined, columns: declared };
  const named = namedKeyEntry(declared);
  if (named === undefined) {
    throw new TypeError("The table's primaryKey takes a list of columns or { name, columns }");
  }
  return named;
}

function namedKeyEntry(declared: unknown): { name: string; columns: unknown } | undefined {
  if (typeof declared !== "object" || declared === null || !("name" in declared)) return undefined;
  const { name } = declared;
  if (typeof name !== "string") return undefined;
  return { name, columns: "columns" in declared && declared.columns };
}

function refuseKeyAndUnique(columns: Columns): void {
  const both = Object.entries(columns).find(([, { state }]) => state.primaryKey && state.unique);
  if (both !== undefined) {
    throw new Error(
      `Column "${both[0]}" calls both primaryKey() and unique(); a primary key is already unique`,
    );
  }
}

function renamedFromOf(declared: unknown): string | undefined {
  if (declared === undefined || typeof declared === "string") return declared;
  throw new TypeError("The table's renamedFrom takes the old SQL name as a string");
}

function sqlNameOf(declared: unknown): string | undefined {
  if (declared === undefined || typeof declared === "string") return declared;
  throw new TypeError("The table's name takes its SQL name as a string");
}

type Extras = {
  readonly primaryKey?: unknown;
  readonly unique?: unknown;
  readonly foreignKeys?: unknown;
  readonly indexes?: unknown;
  readonly renamedFrom?: unknown;
  readonly name?: unknown;
};

function declaredExtras<C extends Columns>(
  own: ReturnType<typeof refsOf>,
  extras: ((t: ColumnRefs<C>) => Extras) | undefined,
): Extras | undefined {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- refsOf builds one Ref per key; "~table" exists only in types.
  return extras?.(own as unknown as ColumnRefs<C>);
}

function keysOf(columns: Columns, own: RuntimeRefs, declared: Extras | undefined) {
  return {
    primaryKey: primaryKeyOf(columns, own, declared?.primaryKey),
    uniques: uniquesOf(own, declared?.unique),
    declaredForeignKeys: declaredForeignKeysOf(own, declared?.foreignKeys),
    indexes: indexesOf(own, declared?.indexes),
  };
}

export function defineTable<C extends Columns, Args extends ExtrasArgs<C, Args>>(
  define: (c: ColumnFactories) => C,
  ...args: Args
): TableDefinition<C, KeyOf<C, Args>> {
  const columns = define(factories);
  const own = refsOf(columns);
  const declared = declaredExtras<C>(own, args[0]);
  const { primaryKey, uniques, declaredForeignKeys, indexes } = keysOf(columns, own, declared);
  const renamedFrom = renamedFromOf(declared?.renamedFrom);
  const explicitName = sqlNameOf(declared?.name);
  refuseKeyAndUnique(columns);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the key names are checked above.
  return {
    columns,
    primaryKey: primaryKey.columns,
    primaryKeyName: primaryKey.name,
    uniques,
    declaredForeignKeys,
    indexes,
    explicitName,
    renamedFrom,
  } as unknown as TableDefinition<C, KeyOf<C, Args>>;
}

type TypesOf<Col> = Col extends {
  readonly "~types": { readonly value: infer V; readonly notNull: infer N };
}
  ? { value: V; notNull: N }
  : never;

type ValueOf<Col, Keyed extends boolean = false> = Keyed extends true
  ? TypesOf<Col>["value"]
  : TypesOf<Col>["notNull"] extends true
    ? TypesOf<Col>["value"]
    : TypesOf<Col>["value"] | null;

/** The row type of table `T`, inferred from its columns. A driver's untyped result row is `DriverRow` in the ports module. */
export type Row<T extends TableDefinition> = {
  -readonly [K in keyof T["columns"]]: ValueOf<
    T["columns"][K],
    K extends T["primaryKey"][number] ? true : false
  >;
};
