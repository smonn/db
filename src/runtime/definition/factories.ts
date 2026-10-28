import { column, type Column } from "./column.ts";
import type { Domain } from "./domain.ts";
import type { Enum } from "./enum.ts";

/** A fresh column of SQL type class `Sql`, for alternative D of the #658 probe. */
type Fresh<V, Sql extends string, Int extends boolean = false> = Column<
  V,
  false,
  Int,
  false,
  false,
  false,
  false,
  false,
  true,
  Sql
>;

export type ColumnFactories = {
  /** `T` narrows the TypeScript type only, like `jsonb<T>()`: the catalog and the database never see it. */
  readonly text: <T extends string = string>() => Fresh<T, "text">;
  readonly varchar: <T extends string = string>(length: number) => Fresh<T, "text">;
  readonly smallint: () => Fresh<number, "number", true>;
  readonly integer: () => Fresh<number, "number", true>;
  readonly bigint: () => Fresh<bigint, "number", true>;
  /** Without a precision the column holds any number of digits. */
  readonly numeric: (precision?: number, scale?: number) => Fresh<string, "number">;
  readonly real: () => Fresh<number, "number">;
  readonly doublePrecision: () => Fresh<number, "number">;
  readonly boolean: () => Fresh<boolean, "boolean">;
  readonly uuid: () => Fresh<string, "uuid">;
  readonly date: () => Fresh<string, "time">;
  readonly timestamp: () => Fresh<Date, "time">;
  readonly timestamptz: () => Fresh<Date, "time">;
  readonly jsonb: <T = unknown>() => Fresh<T, "jsonb">;
  readonly bytea: () => Fresh<Uint8Array, "bytea">;
  /** An enum from the same Database, rolled up under a schema beside the tables. */
  readonly enum: <L extends readonly string[]>(
    type: Enum<L>,
  ) => Fresh<L[number], `enum:${L[number]}`>;
  /** A domain from the same Database; a NOT NULL one makes the column non-null in `Row`. */
  readonly domain: <V, N extends boolean>(type: Domain<V, N>) => Column<V, N>;
};

function of<V, Int extends boolean = false, N extends boolean = false, Sql extends string = string>(
  sqlType: string,
  named: { readonly enumType?: Enum; readonly domainType?: Domain } = {},
): Column<V, N, Int, false, false, false, false, false, true, Sql> {
  return column<V, N, Int, false, false, false, false, false, true, Sql>({
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
