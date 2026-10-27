import type { Table } from "../definition/index.ts";
import {
  parseArrayLiteral,
  parseBytea,
  parseDate,
  parseTimestamp,
  type ArrayValue,
} from "../internal/index.ts";

type Column = Table["columns"][string];

/** The SQL type a column's elements are written as: its own, or its domain's base. */
export function elementSqlType(column: Column): string {
  const { sqlType, domainType } = column.state;
  return (domainType === undefined ? sqlType : domainType.base.sqlType).replace(/\(.*\)$/u, "");
}

const asText = (text: string): string => text;

const parsers: Readonly<Record<string, (text: string) => unknown>> = {
  smallint: Number,
  integer: Number,
  real: Number,
  "double precision": Number,
  bigint: BigInt,
  boolean: (text) => text === "t",
  date: parseDate,
  timestamp: parseTimestamp,
  timestamptz: parseTimestamp,
  jsonb: (text): unknown => JSON.parse(text),
  bytea: parseBytea,
};

/**
 * Whether the builder reads this column as array text: an enum or domain array, whose type
 * the driver may not know (ADR-0023). An enum label and a text-like base stay text.
 */
export function isTextArray(column: Column): boolean {
  const { array, enumType, domainType } = column.state;
  return array && (enumType !== undefined || domainType !== undefined);
}

/** Reads one element of this column's array, from the text Postgres wrote. */
function parseElement(column: Column): (text: string) => unknown {
  return parsers[elementSqlType(column)] ?? asText;
}

/** Reads the array text of an enum or domain array column, a NULL element as `null`. */
export function parseTextArray(column: Column, text: string): ArrayValue<unknown> {
  return parseArrayLiteral(text, parseElement(column));
}
