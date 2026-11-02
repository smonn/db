import type { Table } from "../definition/index.ts";
import { elementText, formatArrayLiteral, quoteIdentifier } from "../internal/index.ts";
import type { DriverRow } from "../ports/index.ts";
import { elementSqlType, isTextArray, parseTextArray } from "./array-text.ts";

type Column = Table["columns"][string];
type RuntimeCodec = NonNullable<Column["~codec"]>;

/** Turns a driver row into the row the query declared. */
export type Decode = (row: DriverRow) => DriverRow;

/** Kept apart from the Query, so the type carries no optional brand. */
const decoders = new WeakMap<object, Decode | undefined>();

/** Attaches the decoder the client runs on this query's rows; a query with none is returned as is. */
export function withDecoder<Q extends object>(query: Q, decode: Decode | undefined): Q {
  decoders.set(query, decode);
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
  if (!Array.isArray(value)) return step(value);
  return value.map((item: unknown) => (item === null || item === undefined ? item : step(item)));
}

/** Runs the column's codec on one value, or on one element of an array column. */
function elementEncoder(table: Table, column: string): (base: unknown) => unknown {
  const codec = table.columns[column]?.["~codec"];
  if (codec === undefined) return (base) => base;
  return (base) => {
    try {
      return codec.encode(base);
    } catch (error) {
      throw failure(table, column, "encoding a value", error);
    }
  };
}

function encode(table: Table, column: string, value: unknown): unknown {
  const definition = table.columns[column];
  if (definition === undefined) return value;
  const run = elementEncoder(table, column);
  return definition.state.array ? mapElements(value, run) : run(value);
}

const jsonTypes = new Set(["json", "jsonb"]);

function arrayWriteFailure(table: Table, column: string, cause: unknown): Error {
  const where = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  return new Error(`Can't write the array in column ${quoteIdentifier(column)} of ${where}`, {
    cause,
  });
}

// Array text leaves no array for a driver to type by its first element, and Postgres types the
// param from the column it meets, as ADR-0023 asks.
function arrayText(
  table: Table,
  column: string,
  definition: Column,
  value: readonly unknown[],
): string {
  const formatElement = jsonTypes.has(elementSqlType(definition))
    ? (element: unknown) => JSON.stringify(element)
    : elementText;
  try {
    return formatArrayLiteral(value, formatElement);
  } catch (error) {
    throw arrayWriteFailure(table, column, error);
  }
}

/**
 * Runs the column's codec on a value headed for the driver, on each element of an array column,
 * then writes an array column's value as array text; NULL passes through. Use it for a
 * comparison operand; a value written to a column goes through `encodeAssigned`.
 */
export function encodeValue(table: Table, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const encoded = encode(table, column, value);
  const definition = table.columns[column];
  return definition?.state.array === true && Array.isArray(encoded)
    ? arrayText(table, column, definition, encoded)
    : encoded;
}

function isJsonDomain(definition: Column): boolean {
  return (
    !definition.state.array &&
    definition.state.domainType !== undefined &&
    jsonTypes.has(elementSqlType(definition))
  );
}

/**
 * `encodeValue` for a value an insert assigns. A param assigned to a domain column keeps the
 * domain's OID, which the driver has no serializer for, so a json or jsonb domain's value is
 * written as JSON here. A comparison's param takes the base type, which the driver serializes.
 * Use it for every value written to a column: insert values, update `set`, upsert `doUpdate`.
 */
export function encodeAssigned(table: Table, column: string, value: unknown): unknown {
  const encoded = encodeValue(table, column, value);
  const definition = table.columns[column];
  if (encoded === null || encoded === undefined || definition === undefined) return encoded;
  return isJsonDomain(definition) ? JSON.stringify(encoded) : encoded;
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

/** The value of `includes`: one element of an array column, through the codec that runs on each. */
export function encodeElement(table: Table, column: string, value: unknown): unknown {
  return elementEncoder(table, column)(value);
}

/**
 * The list `in` and `notIn` match: each value through the column's codec, written as array text so
 * Postgres types the param from the column, even for an enum created after the connection opened.
 */
export function encodeList(
  table: Table,
  column: string,
  definition: Column,
  values: readonly unknown[],
): string {
  const encoded = values.map(elementEncoder(table, column));
  if (!jsonTypes.has(elementSqlType(definition))) {
    return arrayText(table, column, definition, encoded);
  }
  try {
    return formatArrayLiteral(
      encoded.map((value) => (value === null ? null : JSON.stringify(value))),
    );
  } catch (error) {
    throw arrayWriteFailure(table, column, error);
  }
}
