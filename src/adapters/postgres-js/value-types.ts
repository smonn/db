import type postgres from "postgres";

const bigint: postgres.PostgresType<bigint> = {
  to: 20,
  from: [20],
  serialize: (value) => value.toString(),
  parse: BigInt,
};

const date: postgres.PostgresType<string> = {
  to: 1082,
  from: [1082],
  serialize: (value) => value,
  parse: (text: string) => text,
};

// Postgres sends a timestamp without a zone, which `new Date` would read as local time.
const timestamp: postgres.PostgresType<Date> = {
  to: 1114,
  from: [1114],
  serialize: (value) => value.toISOString(),
  parse: (text: string) => new Date(`${text.replace(" ", "T")}Z`),
};

const bytea: postgres.PostgresType<Uint8Array> = {
  to: 17,
  from: [17],
  serialize: (value) => `\\x${Buffer.from(value).toString("hex")}`,
  parse: (text: string) => Uint8Array.from(Buffer.from(text.slice(2), "hex")),
};

/**
 * The postgres.js `types` option that gives columns the Definition's value types: bigint as
 * `bigint`, date as the `YYYY-MM-DD` string, timestamp as a UTC `Date`, and bytea as a plain
 * `Uint8Array`. Pass it when creating the client: `postgres(url, { types: postgresJsTypes })`.
 */
export const postgresJsTypes: {
  readonly bigint: postgres.PostgresType<bigint>;
  readonly date: postgres.PostgresType<string>;
  readonly timestamp: postgres.PostgresType<Date>;
  readonly bytea: postgres.PostgresType<Uint8Array>;
} = { bigint, date, timestamp, bytea };

export function hasPostgresJsTypes(parsers: Record<number, unknown>): boolean {
  return (
    parsers[bigint.to] === bigint.parse &&
    parsers[date.to] === date.parse &&
    parsers[timestamp.to] === timestamp.parse &&
    parsers[bytea.to] === bytea.parse
  );
}
