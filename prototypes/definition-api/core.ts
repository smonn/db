// PROTOTYPE, throwaway. The column model all three variants share, so they
// differ only in how a Definition is structured.

export interface SqlFragment {
  readonly kind: "sql";
  readonly text: string;
}

export function sql(strings: TemplateStringsArray): SqlFragment {
  return { kind: "sql", text: strings.join("") };
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Flags {
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
}

interface Defaults {
  nullable: false;
  hasDefault: false;
  generated: false;
}

export interface ColumnState {
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly default: SqlFragment | { readonly value: unknown } | undefined;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly identity: boolean;
}

// Columns are NOT NULL unless marked nullable().
export interface Column<T, F extends Flags = Defaults> {
  readonly state: ColumnState;
  // Type-only: carries the value type and flags for Row and NewRow.
  readonly "~types"?: { value: T; flags: F };
  nullable(): Column<T, { nullable: true; hasDefault: F["hasDefault"]; generated: F["generated"] }>;
  default(value: T | SqlFragment): Column<T, { nullable: F["nullable"]; hasDefault: true; generated: F["generated"] }>;
  primaryKey(
    ...error: F["nullable"] extends true ? [error: "a nullable column cannot be the primary key"] : []
  ): Column<T, F>;
  unique(): Column<T, F>;
  generatedAlwaysAsIdentity(
    ...error: T extends number | bigint ? [] : [error: "identity needs smallint, integer, or bigint"]
  ): Column<T, { nullable: F["nullable"]; hasDefault: F["hasDefault"]; generated: true }>;
}

function build<T>(state: ColumnState): Column<T, any> {
  return {
    state,
    nullable: () => build({ ...state, nullable: true }),
    default: (value: unknown) =>
      build({ ...state, default: isSql(value) ? value : { value } }),
    primaryKey: () => build({ ...state, primaryKey: true }),
    unique: () => build({ ...state, unique: true }),
    generatedAlwaysAsIdentity: () => build({ ...state, identity: true }),
  } as Column<T, any>;
}

function column<T>(sqlType: string): Column<T> {
  return build({ sqlType, nullable: false, default: undefined, primaryKey: false, unique: false, identity: false });
}

function isSql(value: unknown): value is SqlFragment {
  return typeof value === "object" && value !== null && (value as SqlFragment).kind === "sql";
}

// The v0.1 core set. TypeScript value types follow postgres.js defaults where
// they are safe; codecs that override them are fog on the map.
export const text = () => column<string>("text");
export const varchar = (length: number) => column<string>(`varchar(${length})`);
export const smallint = () => column<number>("smallint");
export const integer = () => column<number>("integer");
export const bigint = () => column<bigint>("bigint");
export const numeric = (precision?: number, scale?: number) =>
  column<string>(
    precision === undefined ? "numeric" : scale === undefined ? `numeric(${precision})` : `numeric(${precision}, ${scale})`,
  );
export const real = () => column<number>("real");
export const doublePrecision = () => column<number>("double precision");
export const boolean = () => column<boolean>("boolean");
export const uuid = () => column<string>("uuid");
export const date = () => column<string>("date");
export const timestamp = () => column<Date>("timestamp");
export const timestamptz = () => column<Date>("timestamptz");
export const jsonb = <T extends Json = Json>() => column<T>("jsonb");
export const bytea = () => column<Uint8Array>("bytea");

export type Columns = Record<string, Column<any, any>>;

export interface TableOptions<C extends Columns> {
  readonly primaryKey?: readonly [keyof C & string, ...(keyof C & string)[]];
}

export interface Table<C extends Columns = Columns> {
  readonly kind: "table";
  readonly schema: string;
  readonly name: string;
  readonly columns: C;
  readonly options: TableOptions<C> | undefined;
}

export function makeTable<C extends Columns>(
  schema: string,
  name: string,
  columns: C,
  options: TableOptions<C> | undefined,
): Table<C> {
  return { kind: "table", schema, name, columns, options };
}

export function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && (value as Table).kind === "table";
}

type Simplify<T> = { [K in keyof T]: T[K] };
type TypesOf<Col> = Col extends { "~types"?: { value: infer T; flags: infer F } } ? { value: T; flags: F } : never;
type ValueOf<Col> = TypesOf<Col>["flags"] extends { nullable: true }
  ? TypesOf<Col>["value"] | null
  : TypesOf<Col>["value"];
type IsRequired<Col> = TypesOf<Col>["flags"] extends Defaults ? true : false;
type IsOptional<Col> = TypesOf<Col>["flags"] extends { generated: true }
  ? false
  : IsRequired<Col> extends true
    ? false
    : true;

// What a Query returns.
export type Row<T extends { columns: Columns }> = {
  -readonly [K in keyof T["columns"]]: ValueOf<T["columns"][K]>;
};

// What an INSERT accepts: defaults and nullable columns are optional, identity columns absent.
export type NewRow<T extends { columns: Columns }> = Simplify<
  { [K in keyof T["columns"] as IsRequired<T["columns"][K]> extends true ? K : never]: ValueOf<T["columns"][K]> } & {
    [K in keyof T["columns"] as IsOptional<T["columns"][K]> extends true ? K : never]?: ValueOf<T["columns"][K]>;
  }
>;

// What the diff consumes. Dev-time only; shown here so the demo can print it.
export interface CatalogTable {
  schema: string;
  name: string;
  columns: { name: string; type: string; nullable: boolean; default: string | null; identity: boolean }[];
  primaryKey: string[];
  unique: string[][];
}

export function toCatalog(tables: readonly Table[]): CatalogTable[] {
  return tables
    .map((table) => {
      const entries = Object.entries(table.columns);
      const columnKey = entries.filter(([, c]) => c.state.primaryKey).map(([name]) => name);
      if (columnKey.length > 0 && table.options?.primaryKey) {
        throw new Error(`${table.schema}.${table.name}: declare the primary key on columns or in options, not both`);
      }
      if (columnKey.length > 1) {
        throw new Error(`${table.schema}.${table.name}: use options.primaryKey for a composite key`);
      }
      return {
        schema: table.schema,
        name: table.name,
        columns: entries.map(([name, c]) => ({
          name,
          type: c.state.sqlType,
          nullable: c.state.nullable,
          default: renderDefault(c.state.default),
          identity: c.state.identity,
        })),
        primaryKey: table.options?.primaryKey ? [...table.options.primaryKey] : columnKey,
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
