import {
  column,
  type Column,
  type ColumnFlags,
  type FreshFlags,
  type WithFlags,
} from "./column.ts";
import type { Domain } from "./domain.ts";
import type { Enum } from "./enum.ts";
import type { ScalarClass } from "./sql-class.ts";

/** A fresh column of the class `S`. */
type FreshClassFlags<S extends ScalarClass> = WithFlags<FreshFlags, { sqlClass: S }>;

/** A fresh column of a type Postgres allows an identity on. */
type FreshIntFlags = WithFlags<FreshFlags, { int: true; sqlClass: "number" }>;

export type ColumnFactories = {
  /** `T` narrows the TypeScript type only, like `jsonb<T>()`: the catalog and the database never see it. */
  readonly text: <T extends string = string>() => Column<T, FreshClassFlags<"text">>;
  readonly varchar: <T extends string = string>(
    length: number,
  ) => Column<T, FreshClassFlags<"text">>;
  readonly smallint: () => Column<number, FreshIntFlags>;
  readonly integer: () => Column<number, FreshIntFlags>;
  readonly bigint: () => Column<bigint, FreshIntFlags>;
  /** Without a precision the column holds any number of digits. */
  readonly numeric: (
    precision?: number,
    scale?: number,
  ) => Column<string, FreshClassFlags<"number">>;
  readonly real: () => Column<number, FreshClassFlags<"number">>;
  readonly doublePrecision: () => Column<number, FreshClassFlags<"number">>;
  readonly boolean: () => Column<boolean, FreshClassFlags<"boolean">>;
  readonly uuid: () => Column<string, FreshClassFlags<"uuid">>;
  readonly date: () => Column<string, FreshClassFlags<"time">>;
  readonly timestamp: () => Column<Date, FreshClassFlags<"time">>;
  readonly timestamptz: () => Column<Date, FreshClassFlags<"time">>;
  readonly jsonb: <T = unknown>() => Column<T, FreshClassFlags<"jsonb">>;
  readonly bytea: () => Column<Uint8Array, FreshClassFlags<"bytea">>;
  /** An enum from the same Database, rolled up under a schema beside the tables. */
  readonly enum: <L extends readonly string[]>(
    type: Enum<L>,
  ) => Column<L[number], FreshClassFlags<"enum">>;
  /** A domain from the same Database; a NOT NULL one makes the column non-null in `Row`. */
  readonly domain: <V, N extends boolean, S extends ScalarClass>(
    type: Domain<V, N, S>,
  ) => Column<V, WithFlags<FreshFlags, { notNull: N; sqlClass: S }>>;
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
