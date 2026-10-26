import type { Table } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";
import type { DriverRow } from "../ports/index.ts";

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

/** Runs the column's codec on a value headed for the driver; NULL and codec-free columns pass through. */
export function encodeValue(table: Table, column: string, value: unknown): unknown {
  const codec = table.columns[column]?.["~codec"];
  if (codec === undefined || value === null || value === undefined) return value;
  try {
    return codec.encode(value);
  } catch (error) {
    throw failure(table, column, "encoding a value", error);
  }
}

/** Decodes the outputs that come from a codec'd column, matched by alias; undefined when none does. */
export function decoderFor(
  table: Table,
  outputs: readonly (readonly [alias: string, column: string])[],
): Decode | undefined {
  const coded = outputs.flatMap(([alias, column]) => {
    const codec = table.columns[column]?.["~codec"];
    return codec === undefined ? [] : [{ alias, column, codec }];
  });
  if (coded.length === 0) return undefined;
  return (row) => {
    const decoded = { ...row };
    for (const { alias, column, codec } of coded) {
      const value = row[alias];
      if (value === null || value === undefined) continue;
      try {
        decoded[alias] = codec.decode(value);
      } catch (error) {
        throw failure(table, column, "decoding a value", error);
      }
    }
    return decoded;
  };
}
