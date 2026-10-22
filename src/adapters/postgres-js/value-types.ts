import type { Sql } from "postgres";

const bigint = 20;
const bytea = 17;
const date = 1082;
const timestamp = 1114;

/**
 * Sets the parsers that give columns the Definition's value types, replacing postgres.js's defaults:
 * bigint as `bigint`, date as the `YYYY-MM-DD` string, timestamp as a UTC `Date`, and bytea as a
 * plain `Uint8Array`.
 */
export function useDefinitionValueTypes(sql: Sql): void {
  const { parsers } = sql.options;
  parsers[bigint] = BigInt;
  parsers[date] = (text: string) => text;
  // Postgres sends a timestamp without a zone, which `new Date` would read as local time.
  parsers[timestamp] = (text: string) => new Date(`${text.replace(" ", "T")}Z`);
  parsers[bytea] = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}
