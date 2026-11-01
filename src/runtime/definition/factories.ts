import {
  column,
  type Column,
  type ColumnFlags,
  type FreshFlags,
  type WithFlags,
} from "./column.ts";
import type { Domain } from "./domain.ts";
import type { Enum } from "./enum.ts";

/** A fresh column of a type Postgres allows an identity on. */
type FreshIntFlags = WithFlags<FreshFlags, { int: true }>;

export type ColumnFactories = {
  /** `T` narrows the TypeScript type only, like `jsonb<T>()`: the catalog and the database never see it. */
  readonly text: <T extends string = string>() => Column<T>;
  readonly varchar: <T extends string = string>(length: number) => Column<T>;
  readonly smallint: () => Column<number, FreshIntFlags>;
  readonly integer: () => Column<number, FreshIntFlags>;
  readonly bigint: () => Column<bigint, FreshIntFlags>;
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
  /** An enum from the same Database, rolled up under a schema beside the tables. */
  readonly enum: <L extends readonly string[]>(type: Enum<L>) => Column<L[number]>;
  /** A domain from the same Database; a NOT NULL one makes the column non-null in `Row`. */
  readonly domain: <V, N extends boolean>(
    type: Domain<V, N>,
  ) => Column<V, WithFlags<FreshFlags, { notNull: N }>>;
};

function of<V, F extends ColumnFlags>(
  sqlType: string,
  named: { readonly enumType?: Enum; readonly domainType?: Domain } = {},
): Column<V, F> {
  return column({
    sqlType,
    enumType: named.enumType,
    domainType: named.domainType,
    array: false,
    notNull: false,
    default: undefined,
    identity: undefined,
    primaryKey: false,
    unique: false,
    indexes: [],
    constraintName: undefined,
    explicitName: undefined,
    renamedFrom: undefined,
    references: undefined,
  });
}

function numericType(precision?: number, scale?: number): string {
  if (precision === undefined) return "numeric";
  return scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
}

export const factories: ColumnFactories = {
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
  enum: (enumType) => of("", { enumType }),
  domain: (domainType) => of("", { domainType }),
};
