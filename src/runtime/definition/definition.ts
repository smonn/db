export type ColumnState = {
  readonly sqlType: string;
  readonly notNull: boolean;
};

export type Column<V, N extends boolean = false> = {
  readonly state: ColumnState;
  /** Type-only: the value a row holds and whether the column is NOT NULL. */
  readonly "~types": { readonly value: V; readonly notNull: N };
  notNull(): Column<V, true>;
};

function column<V, N extends boolean>(state: ColumnState): Column<V, N> {
  const parts = { state, notNull: () => column<V, true>({ ...state, notNull: true }) };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types.
  return parts as Column<V, N>;
}

export type ColumnFactories = {
  readonly text: () => Column<string>;
  readonly varchar: (length: number) => Column<string>;
  readonly smallint: () => Column<number>;
  readonly integer: () => Column<number>;
  readonly bigint: () => Column<bigint>;
  /** Without a precision the column holds any number of digits. */
  readonly numeric: (precision?: number, scale?: number) => Column<string>;
  readonly real: () => Column<number>;
  readonly doublePrecision: () => Column<number>;
  readonly boolean: () => Column<boolean>;
  readonly uuid: () => Column<string>;
  readonly date: () => Column<string>;
  readonly timestamp: () => Column<Date>;
  readonly timestamptz: () => Column<Date>;
  readonly jsonb: <T = unknown>() => Column<T>;
  readonly bytea: () => Column<Uint8Array>;
};

function of<V>(sqlType: string): Column<V> {
  return column<V, false>({ sqlType, notNull: false });
}

function numericType(precision?: number, scale?: number): string {
  if (precision === undefined) return "numeric";
  return scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
}

const factories: ColumnFactories = {
  text: () => of("text"),
  varchar: (length) => of(`varchar(${length})`),
  smallint: () => of("smallint"),
  integer: () => of("integer"),
  bigint: () => of("bigint"),
  numeric: (precision, scale) => of(numericType(precision, scale)),
  real: () => of("real"),
  doublePrecision: () => of("double precision"),
  boolean: () => of("boolean"),
  uuid: () => of("uuid"),
  date: () => of("date"),
  timestamp: () => of("timestamp"),
  timestamptz: () => of("timestamptz"),
  jsonb: () => of("jsonb"),
  bytea: () => of("bytea"),
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
  readonly "~types": { readonly value: infer V; readonly notNull: infer N };
}
  ? { value: V; notNull: N }
  : never;

type ValueOf<Col> = TypesOf<Col>["notNull"] extends true
  ? TypesOf<Col>["value"]
  : TypesOf<Col>["value"] | null;

export type Row<T extends TableDefinition> = {
  -readonly [K in keyof T["columns"]]: ValueOf<T["columns"][K]>;
};
