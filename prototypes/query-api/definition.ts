// PROTOTYPE, throwaway. The Definition API picked in "Definition API shape"
// (variant D on prototype/definition-api), trimmed to what queries need.

export interface SqlFragment {
  readonly kind: "sql";
  readonly text: string;
}

export function sql(strings: TemplateStringsArray): SqlFragment {
  return { kind: "sql", text: strings.join("") };
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Flags {
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

interface Defaults {
  notNull: false;
  hasDefault: false;
  generated: false;
}

export interface ColumnState {
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly default: SqlFragment | { readonly value: unknown } | undefined;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly identity: boolean;
}

export interface Column<T, F extends Flags = Defaults> {
  readonly state: ColumnState;
  readonly "~types"?: { value: T; flags: F };
  notNull(): Column<T, { notNull: true; hasDefault: F["hasDefault"]; generated: F["generated"] }>;
  default(value: T | SqlFragment): Column<T, { notNull: F["notNull"]; hasDefault: true; generated: F["generated"] }>;
  primaryKey(): Column<T, { notNull: true; hasDefault: F["hasDefault"]; generated: F["generated"] }>;
  unique(): Column<T, F>;
  generatedAlwaysAsIdentity(
    ...error: T extends number | bigint ? [] : [error: "identity needs smallint, integer, or bigint"]
  ): Column<T, { notNull: true; hasDefault: F["hasDefault"]; generated: true }>;
}

function build<T>(state: ColumnState): Column<T, any> {
  return {
    state,
    notNull: () => build({ ...state, notNull: true }),
    default: (value: unknown) => build({ ...state, default: isSql(value) ? value : { value } }),
    primaryKey: () => build({ ...state, primaryKey: true }),
    unique: () => build({ ...state, unique: true }),
    generatedAlwaysAsIdentity: () => build({ ...state, identity: true }),
  } as Column<T, any>;
}

function column<T>(sqlType: string): Column<T> {
  return build({ sqlType, notNull: false, default: undefined, primaryKey: false, unique: false, identity: false });
}

function isSql(value: unknown): value is SqlFragment {
  return typeof value === "object" && value !== null && (value as SqlFragment).kind === "sql";
}

const factories = {
  text: () => column<string>("text"),
  varchar: (length: number) => column<string>(`varchar(${length})`),
  smallint: () => column<number>("smallint"),
  integer: () => column<number>("integer"),
  bigint: () => column<bigint>("bigint"),
  numeric: (precision?: number, scale?: number) =>
    column<string>(
      precision === undefined ? "numeric" : scale === undefined ? `numeric(${precision})` : `numeric(${precision}, ${scale})`,
    ),
  real: () => column<number>("real"),
  doublePrecision: () => column<number>("double precision"),
  boolean: () => column<boolean>("boolean"),
  uuid: () => column<string>("uuid"),
  date: () => column<string>("date"),
  timestamp: () => column<Date>("timestamp"),
  timestamptz: () => column<Date>("timestamptz"),
  jsonb: <T extends Json = Json>() => column<T>("jsonb"),
  bytea: () => column<Uint8Array>("bytea"),
  sql,
};

export type ColumnFactories = typeof factories;

export type Columns = Record<string, Column<any, any>>;

type Key<C> = readonly [keyof C & string, ...(keyof C & string)[]];

export interface TableDefinition<C extends Columns = Columns, P extends readonly string[] = readonly string[]> {
  readonly kind: "table-definition";
  readonly columns: C;
  readonly primaryKey: P | undefined;
}

export function defineTable<C extends Columns, const P extends Key<NoInfer<C>> | [] = []>(
  define: (c: ColumnFactories) => C,
  options?: { readonly primaryKey?: P },
): TableDefinition<C, P> {
  return { kind: "table-definition", columns: define(factories), primaryKey: options?.primaryKey };
}

export interface Table<C extends Columns = Columns, P extends readonly string[] = readonly string[]>
  extends Omit<TableDefinition<C, P>, "kind"> {
  readonly kind: "table";
  readonly schema: string;
  readonly name: string;
}

type Schemas = Record<string, Record<string, TableDefinition<any, any>>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: S[Schema][Name] extends TableDefinition<infer C, infer P> ? Table<C, P> : never;
  };
};

export function defineDatabase<S extends Schemas>(schemas: S): Database<S> {
  return Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, def]) => [
          name,
          { kind: "table", schema, name, columns: def.columns, primaryKey: def.primaryKey },
        ]),
      ),
    ]),
  ) as Database<S>;
}

export type Simplify<T> = { [K in keyof T]: T[K] } & {};
type TypesOf<Col> = Col extends { "~types"?: { value: infer T; flags: infer F } } ? { value: T; flags: F } : never;
export type IsNotNull<Col, K, P extends readonly string[]> = TypesOf<Col>["flags"] extends { notNull: true }
  ? true
  : K extends P[number]
    ? true
    : false;
export type BaseValue<Col> = TypesOf<Col>["value"];
type ValueOf<Col, K, P extends readonly string[]> =
  IsNotNull<Col, K, P> extends true ? TypesOf<Col>["value"] : TypesOf<Col>["value"] | null;
type IsRequired<Col, K, P extends readonly string[]> =
  IsNotNull<Col, K, P> extends true ? (TypesOf<Col>["flags"] extends { hasDefault: false; generated: false } ? true : false) : false;
type IsOptional<Col, K, P extends readonly string[]> = TypesOf<Col>["flags"] extends { generated: true }
  ? false
  : IsRequired<Col, K, P> extends true
    ? false
    : true;

export type AnyTable = { columns: Columns; primaryKey: readonly string[] | undefined };
export type KeyOf<T extends AnyTable> = Exclude<T["primaryKey"], undefined>;

export type Row<T extends AnyTable> = {
  -readonly [K in keyof T["columns"]]: ValueOf<T["columns"][K], K, KeyOf<T>>;
};

export type NewRow<T extends AnyTable> = Simplify<
  {
    [K in keyof T["columns"] as IsRequired<T["columns"][K], K, KeyOf<T>> extends true ? K : never]: ValueOf<
      T["columns"][K],
      K,
      KeyOf<T>
    >;
  } & {
    [K in keyof T["columns"] as IsOptional<T["columns"][K], K, KeyOf<T>> extends true ? K : never]?: ValueOf<
      T["columns"][K],
      K,
      KeyOf<T>
    >;
  }
>;
