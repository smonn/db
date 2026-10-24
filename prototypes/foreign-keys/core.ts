/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway: the column model and foreign key resolution every variant shares.

export type Action = "no action" | "restrict" | "cascade" | "set null" | "set default";

export type ForeignKeyOptions = {
  readonly name?: string;
  readonly onDelete?: Action;
  readonly onUpdate?: Action;
  readonly deferrable?: "immediate" | "deferred";
};

/** A table-level entry can also set MATCH, which only matters for several columns. */
export type TableForeignKeyOptions = ForeignKeyOptions & { readonly match?: "simple" | "full" };

/** What a declared foreign key holds before `defineDatabase` names its target. */
export type ForeignKeyDecl = {
  readonly columns: readonly string[];
  /** Another table's columns, read lazily so tables in an import cycle can point at each other. */
  readonly target:
    | { readonly self: readonly string[] }
    | { readonly other: () => readonly AnyColumn[] };
  readonly options: TableForeignKeyOptions;
};

export type ColumnState = {
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** Its own slot, apart from the key's constraint name (#351, third point). */
  readonly references:
    | { readonly target: () => AnyColumn; readonly options: ForeignKeyOptions }
    | undefined;
};

export type Types<V, N extends boolean, Key extends boolean> = {
  readonly value: V;
  readonly notNull: N;
  /** True once `.primaryKey()` or `.unique()` ran, so a foreign key can point at the column. */
  readonly key: Key;
};

export type AnyColumn = {
  readonly state: ColumnState;
  readonly "~types": Types<unknown, boolean, boolean>;
};

/** What a foreign key may point at: a primary key or unique column holding a `V`. */
export type Target<V> = {
  readonly state: ColumnState;
  readonly "~types": Types<V, boolean, true>;
};

export type Columns = Record<string, AnyColumn>;

// Every builder is the same at runtime; the variants differ in the types they expose.
export function column(state: ColumnState): unknown {
  return {
    state,
    notNull: () => column({ ...state, notNull: true }),
    primaryKey: () => column({ ...state, notNull: true, primaryKey: true }),
    unique: () => column({ ...state, unique: true }),
    references: (target: () => AnyColumn, options: ForeignKeyOptions = {}) =>
      column({ ...state, references: { target, options } }),
  };
}

export function of(sqlType: string): unknown {
  return column({
    sqlType,
    notNull: false,
    primaryKey: false,
    unique: false,
    references: undefined,
  });
}

/** A `Ref` at runtime; the type brand exists only in types, as in `src/`. */
export type RuntimeRef = { readonly "~ref": string };

export function refsOf(columns: Columns): Record<string, RuntimeRef> {
  return Object.fromEntries(Object.keys(columns).map((name) => [name, { "~ref": name }]));
}

export function ownColumn(own: Record<string, RuntimeRef>, ref: unknown): string {
  const name = (ref as RuntimeRef)["~ref"];
  if (own[name] !== ref) throw new Error(`"${name}" is another table's reference`);
  return name;
}

export type TableDefinition<C extends Columns = Columns> = {
  readonly columns: C;
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeyDecl[];
};

/** Column-level `.references()` calls become entries like the table-level ones. */
export function columnForeignKeys(columns: Columns): ForeignKeyDecl[] {
  return Object.entries(columns).flatMap(([name, { state }]) => {
    const references = state.references;
    if (references === undefined) return [];
    return [
      {
        columns: [name],
        target: { other: () => [references.target()] },
        options: references.options,
      },
    ];
  });
}

export function primaryKeyOf(columns: Columns, declared: readonly string[]): string[] {
  const single = Object.entries(columns).filter(([, { state }]) => state.primaryKey);
  return declared.length > 0 ? [...declared] : single.map(([name]) => name);
}

export type ForeignKeyFact = {
  readonly kind: "foreign key";
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly payload: {
    readonly columns: readonly string[];
    readonly target: {
      readonly schema: string;
      readonly table: string;
      readonly columns: readonly string[];
    };
    readonly onDelete: Action;
    readonly onUpdate: Action;
    readonly match: "simple" | "full";
    readonly deferrable: "not deferrable" | "immediate" | "deferred";
  };
};

type Place = { readonly schema: string; readonly table: string; readonly column: string };

type Schemas = Record<string, Record<string, TableDefinition>>;

/**
 * `defineDatabase` is the first point where every table has a name, so it finds each target column
 * by identity and refuses one outside the Database (#351, second point).
 */
export function resolve(schemas: Schemas): ForeignKeyFact[] {
  const places = new Map<AnyColumn, Place>();
  for (const [schema, tables] of Object.entries(schemas)) {
    for (const [table, { columns }] of Object.entries(tables)) {
      for (const [column, value] of Object.entries(columns)) {
        const seen = places.get(value);
        if (seen !== undefined) {
          throw new Error(
            `${schema}.${table} and ${seen.schema}.${seen.table} are one defineTable value; a foreign key to it can't say which`,
          );
        }
        places.set(value, { schema, table, column });
      }
    }
  }
  const facts: ForeignKeyFact[] = [];
  for (const [schema, tables] of Object.entries(schemas)) {
    for (const [table, definition] of Object.entries(tables)) {
      const names = new Set<string>();
      for (const decl of definition.foreignKeys) {
        const on = `${schema}.${table} (${decl.columns.join(", ")})`;
        const target =
          "self" in decl.target
            ? { schema, table, columns: decl.target.self }
            : targetOf(places, decl.target.other(), on);
        if (target.columns.length !== decl.columns.length) {
          throw new Error(
            `the foreign key on ${on} lists ${decl.columns.length} columns and its target ${target.columns.length}`,
          );
        }
        const targetTable = schemas[target.schema]?.[target.table];
        if (targetTable === undefined || !isKey(targetTable, target.columns)) {
          throw new Error(
            `the foreign key on ${on} points at ${target.schema}.${target.table} (${target.columns.join(", ")}), which is not its primary key or a unique constraint`,
          );
        }
        const name = decl.options.name ?? `${table}_${decl.columns.join("_")}_fkey`;
        if (new TextEncoder().encode(name).length > 63)
          throw new Error(`the constraint name "${name}" is longer than 63 bytes`);
        if (names.has(name))
          throw new Error(`two foreign keys on ${schema}.${table} take the name "${name}"`);
        names.add(name);
        facts.push({
          kind: "foreign key",
          schema,
          table,
          name,
          payload: {
            columns: decl.columns,
            target,
            onDelete: decl.options.onDelete ?? "no action",
            onUpdate: decl.options.onUpdate ?? "no action",
            match: decl.options.match ?? "simple",
            deferrable: decl.options.deferrable ?? "not deferrable",
          },
        });
      }
    }
  }
  return facts;
}

function targetOf(
  places: ReadonlyMap<AnyColumn, Place>,
  columns: readonly AnyColumn[],
  on: string,
) {
  const found = columns.map((column) => {
    const place = places.get(column);
    if (place === undefined) {
      throw new Error(
        `the foreign key on ${on} points at a table that is not in the Database; add it to defineDatabase`,
      );
    }
    return place;
  });
  const [first] = found;
  if (
    first === undefined ||
    found.some((p) => p.schema !== first.schema || p.table !== first.table)
  ) {
    throw new Error(`the foreign key on ${on} points at columns of more than one table`);
  }
  return { schema: first.schema, table: first.table, columns: found.map((p) => p.column) };
}

/** Postgres takes the target columns in any order, as long as a primary key or unique covers exactly them. */
function isKey(table: TableDefinition, columns: readonly string[]): boolean {
  const sameSet = (key: readonly string[]) =>
    key.length === columns.length && key.every((column) => columns.includes(column));
  if (sameSet(table.primaryKey)) return true;
  return columns.length === 1 && table.columns[columns[0] ?? ""]?.state.unique === true;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const list = (names: readonly string[]) => names.map(quote).join(", ");

export function render({ schema, table, name, payload: p }: ForeignKeyFact): string {
  const clauses = [
    p.match === "full" ? " match full" : "",
    p.onDelete === "no action" ? "" : ` on delete ${p.onDelete}`,
    p.onUpdate === "no action" ? "" : ` on update ${p.onUpdate}`,
    p.deferrable === "not deferrable" ? "" : ` deferrable initially ${p.deferrable}`,
  ].join("");
  return `alter table ${quote(schema)}.${quote(table)} add constraint ${quote(name)} foreign key (${list(p.columns)}) references ${quote(p.target.schema)}.${quote(p.target.table)} (${list(p.target.columns)})${clauses};`;
}
