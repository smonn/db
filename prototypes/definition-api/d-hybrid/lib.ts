// PROTOTYPE, throwaway. Variant D stands in for `@smonn/db`: the maintainer's
// B+C hybrid. defineTable takes a column callback and no name; defineDatabase
// rolls tables up by schema, and its keys name them. Columns follow SQL:
// nullable unless notNull(), primaryKey(), or identity says otherwise.

import { sql, type Json, type SqlFragment } from "../core.ts";
import type { CatalogTable } from "../core.ts";

export { sql, type Json, type SqlFragment, type CatalogTable };

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

interface ColumnState {
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
  // PRIMARY KEY implies NOT NULL in Postgres.
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

type Simplify<T> = { [K in keyof T]: T[K] };
type TypesOf<Col> = Col extends { "~types"?: { value: infer T; flags: infer F } } ? { value: T; flags: F } : never;
type IsNotNull<Col, K, P extends readonly string[]> = TypesOf<Col>["flags"] extends { notNull: true }
  ? true
  : K extends P[number]
    ? true
    : false;
type ValueOf<Col, K, P extends readonly string[]> =
  IsNotNull<Col, K, P> extends true ? TypesOf<Col>["value"] : TypesOf<Col>["value"] | null;
type IsRequired<Col, K, P extends readonly string[]> =
  IsNotNull<Col, K, P> extends true ? (TypesOf<Col>["flags"] extends { hasDefault: false; generated: false } ? true : false) : false;
type IsOptional<Col, K, P extends readonly string[]> = TypesOf<Col>["flags"] extends { generated: true }
  ? false
  : IsRequired<Col, K, P> extends true
    ? false
    : true;

type AnyTable = { columns: Columns; primaryKey: readonly string[] | undefined };
type KeyOf<T extends AnyTable> = Exclude<T["primaryKey"], undefined>;

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

// What the CLI does with the default export of the configured Definition file.
export function tablesOf(db: Database<Schemas>): Table[] {
  return Object.values(db).flatMap((tables) => Object.values(tables));
}

export function toCatalog(tables: readonly Table[]): CatalogTable[] {
  return tables
    .map((table) => {
      const entries = Object.entries(table.columns);
      const columnKey = entries.filter(([, c]) => c.state.primaryKey).map(([name]) => name);
      if (columnKey.length > 0 && table.primaryKey && table.primaryKey.length > 0) {
        throw new Error(`${table.schema}.${table.name}: declare the primary key on columns or in options, not both`);
      }
      if (columnKey.length > 1) {
        throw new Error(`${table.schema}.${table.name}: use options.primaryKey for a composite key`);
      }
      const primaryKey = table.primaryKey && table.primaryKey.length > 0 ? [...table.primaryKey] : columnKey;
      return {
        schema: table.schema,
        name: table.name,
        columns: entries.map(([name, c]) => ({
          name,
          type: c.state.sqlType,
          nullable: !(c.state.notNull || c.state.identity || primaryKey.includes(name)),
          default: renderDefault(c.state.default),
          identity: c.state.identity,
        })),
        primaryKey,
        unique: entries.filter(([, c]) => c.state.unique).map(([name]) => [name]),
      };
    })
    .sort((x, y) => `${x.schema}.${x.name}`.localeCompare(`${y.schema}.${y.name}`));
}

function renderDefault(value: ColumnState["default"]): string | null {
  if (value === undefined) return null;
  if (isSql(value)) return value.text;
  const v = value.value;
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
}
