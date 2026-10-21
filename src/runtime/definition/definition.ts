export type ColumnState = {
  readonly sqlType: string;
  readonly notNull: boolean;
};

export type Column<V, N extends boolean = false> = {
  readonly state: ColumnState;
  /** Type-only: the value a row holds and whether the column is NOT NULL. */
  readonly "~types"?: { readonly value: V; readonly notNull: N };
  notNull(): Column<V, true>;
};

function column<V, N extends boolean>(state: ColumnState): Column<V, N> {
  return { state, notNull: () => column<V, true>({ ...state, notNull: true }) };
}

export type ColumnFactories = {
  readonly text: () => Column<string>;
};

const factories: ColumnFactories = {
  text: () => column<string, false>({ sqlType: "text", notNull: false }),
};

export type Columns = Record<string, Column<unknown, boolean>>;

/** A table without its name or schema, which `defineDatabase` gives it. */
export type TableDefinition<C extends Columns = Columns> = {
  readonly columns: C;
};

export type Table<C extends Columns = Columns> = TableDefinition<C> & {
  readonly schema: string;
  readonly name: string;
};

export function defineTable<C extends Columns>(
  define: (c: ColumnFactories) => C,
): TableDefinition<C> {
  return { columns: define(factories) };
}

type Schemas = Record<string, Record<string, TableDefinition>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: Table<S[Schema][Name]["columns"]>;
  };
};

export function defineDatabase<S extends Schemas>(schemas: S): Database<S> {
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, { columns }]) => [name, { schema, name, columns }]),
      ),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return database as Database<S>;
}

type TypesOf<Col> = Col extends {
  readonly "~types"?: { readonly value: infer V; readonly notNull: infer N };
}
  ? { value: V; notNull: N }
  : never;

type ValueOf<Col> = TypesOf<Col>["notNull"] extends true
  ? TypesOf<Col>["value"]
  : TypesOf<Col>["value"] | null;

export type Row<T extends TableDefinition> = {
  -readonly [K in keyof T["columns"]]: ValueOf<T["columns"][K]>;
};
