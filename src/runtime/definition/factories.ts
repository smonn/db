import type { ColumnKind } from "./column-kind.ts";
import { column, type Column } from "./column.ts";
import type { Domain } from "./domain.ts";
import type { Enum } from "./enum.ts";

export type ColumnFactories = {
  /** `T` narrows the TypeScript type only, like `jsonb<T>()`: the catalog and the database never see it. */
  readonly text: <T extends string = string>() => Column<T, false, "text">;
  readonly varchar: <T extends string = string>(length: number) => Column<T, false, "text">;
  readonly smallint: () => Column<number, false, "integer">;
  readonly integer: () => Column<number, false, "integer">;
  readonly bigint: () => Column<bigint, false, "integer">;
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
  readonly domain: <V, N extends boolean, K extends ColumnKind>(
    type: Domain<V, N, K>,
  ) => Column<V, N, K extends "text" ? "text" : "other">;
};

function of<V, Kind extends ColumnKind = "other", N extends boolean = false>(
  sqlType: string,
  named: { readonly enumType?: Enum; readonly domainType?: Domain } = {},
): Column<V, N, Kind> {
  return column<V, N, Kind, false, false, false, false, false, true>({
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
