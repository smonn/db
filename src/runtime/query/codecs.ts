import type { Table } from "../definition/index.ts";
import { elementText, formatArrayLiteral, quoteIdentifier } from "../internal/index.ts";
import type { DriverRow } from "../ports/index.ts";
import { elementSqlType, isTextArray, parseTextArray } from "./array-text.ts";

type Column = Table["columns"][string];
type RuntimeCodec = NonNullable<Column["~codec"]>;

/** Turns a driver row into the row the query declared. */
export type Decode = (row: DriverRow) => DriverRow;

/** Kept apart from the Query, so the type carries no optional brand. */
const decoders = new WeakMap<object, Decode>();

/** Attaches the decoder the client runs on this query's rows; a query with none is returned as is. */
export function withDecoder<Q extends object>(query: Q, decode: Decode | undefined): Q {
  if (decode !== undefined) decoders.set(query, decode);
  return query;
}

export function decoderOf(query: object): Decode | undefined {
  return decoders.get(query);
}

function failure(table: Table, column: string, action: string, cause: unknown): Error {
  const where = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  return new Error(
    `The codec of column ${quoteIdentifier(column)} of ${where} threw while ${action}`,
    { cause },
  );
}

/** Runs `step` on each element of a 1-D array; a NULL element skips it. */
function mapElements(value: unknown, step: (element: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value === null || value === undefined ? value : step(value);
  return value.map((item: unknown) => (item === null || item === undefined ? item : step(item)));
}

function encode(table: Table, column: string, value: unknown): unknown {
  const definition = table.columns[column];
  const codec = definition?.["~codec"];
  if (codec === undefined) return value;
  const run = (base: unknown): unknown => {
    try {
      return codec.encode(base);
    } catch (error) {
      throw failure(table, column, "encoding a value", error);
    }
  };
  return definition?.state.array === true ? mapElements(value, run) : run(value);
}

const jsonTypes = new Set(["json", "jsonb"]);

// Array text leaves no array for a driver to type by its first element, and Postgres types the
// param from the column it meets, as ADR-0023 asks.
function arrayText(table: Table, column: string, value: readonly unknown[]): string {
  const definition = table.columns[column];
  const formatElement =
    definition !== undefined && jsonTypes.has(elementSqlType(definition))
      ? (element: unknown) => JSON.stringify(element)
      : elementText;
  try {
    return formatArrayLiteral(value, formatElement);
  } catch (error) {
    const where = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    throw new Error(`Can't write the array in column ${quoteIdentifier(column)} of ${where}`, {
      cause: error,
    });
  }
}

/**
 * Runs the column's codec on a value headed for the driver, on each element of an array column,
 * then writes an array column's value
 * as array text; NULL passes through.
 */
export function encodeValue(table: Table, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const encoded = encode(table, column, value);
  return table.columns[column]?.state.array === true && Array.isArray(encoded)
    ? arrayText(table, column, encoded)
    : encoded;
}

function readArray(table: Table, column: string, definition: Column, value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return parseTextArray(definition, value);
  } catch (error) {
    const where = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    throw new Error(`Can't read the array in column ${quoteIdentifier(column)} of ${where}`, {
      cause: error,
    });
  }
}

function decodeValue(
  table: Table,
  column: string,
  codec: RuntimeCodec,
): (value: unknown) => unknown {
  return (base) => {
    try {
      return codec.decode(base);
    } catch (error) {
      throw failure(table, column, "decoding a value", error);
    }
  };
}

/** What turns the driver's value for one output into the declared one; undefined when none does. */
function decoderOfColumn(table: Table, column: string): ((value: unknown) => unknown) | undefined {
  const definition = table.columns[column];
  if (definition === undefined) return undefined;
  const codec = definition["~codec"];
  const read = isTextArray(definition)
    ? (value: unknown) => readArray(table, column, definition, value)
    : (value: unknown) => value;
  if (codec === undefined) return isTextArray(definition) ? read : undefined;
  const run = decodeValue(table, column, codec);
  return definition.state.array
    ? (value) => mapElements(read(value), run)
    : (value) => run(read(value));
}

/**
 * Decodes the outputs that need it, matched by alias; undefined when none does. An enum or domain
 * array arrives as text (see `renderOutput`) and is read first, then its codec, if any, runs.
 */
export function decoderFor(
  table: Table,
  outputs: readonly (readonly [alias: string, column: string])[],
): Decode | undefined {
  const steps = outputs.flatMap(([alias, column]) => {
    const decode = decoderOfColumn(table, column);
    return decode === undefined ? [] : [{ alias, decode }];
  });
  if (steps.length === 0) return undefined;
  return (row) => {
    const next = { ...row };
    for (const { alias, decode } of steps) {
      const value = row[alias];
      if (value !== null && value !== undefined) next[alias] = decode(value);
    }
    return next;
  };
}
