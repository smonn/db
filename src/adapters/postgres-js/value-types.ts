import type postgres from "postgres";
import { formatTimestamp } from "../../runtime/internal/index.ts";

const bigint: postgres.PostgresType<bigint> = {
  to: 20,
  from: [20],
  serialize: (value) => value.toString(),
  parse: BigInt,
};

const isoDate = /^(?:\d{4,}-\d\d-\d\d(?: BC)?|-?infinity)$/u;

const date: postgres.PostgresType<string> = {
  to: 1082,
  from: [1082],
  serialize: (value) => value,
  parse: (text: string) => {
    if (!isoDate.test(text)) throw new Error(`Can't read date "${text}" as YYYY-MM-DD`);
    return text;
  },
};

// DateStyle ISO output: a year of four or more digits, up to six fraction digits, and for
// timestamptz an offset that can carry minutes and seconds, such as `+09:18:59` before 1888.
const isoTimestamp =
  /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:([+-])(\d\d)(?::(\d\d))?(?::(\d\d))?)?( BC)?$/u;

function parseTimestamp(text: string): Date {
  const match = isoTimestamp.exec(text);
  // `infinity`, `-infinity`, and years past 275760 have no Date. A timestamp has no offset, which
  // reads as UTC rather than the local time `new Date` would assume.
  if (match === null) throw new Error(`Can't read timestamp "${text}" as a Date`);
  const [, year, month, day, hours, minutes, seconds, fraction, ...offset] = match;
  const bc = offset[4];
  const value = new Date(0);
  // Date.UTC reads years 0 to 99 as 1900 to 1999; setUTCFullYear doesn't. 1 BC is year 0.
  value.setUTCFullYear(
    bc === undefined ? Number(year) : 1 - Number(year),
    Number(month) - 1,
    Number(day),
  );
  setClock(value, [hours, minutes, seconds, fraction], offset);
  if (Number.isNaN(value.getTime())) throw new Error(`Can't read timestamp "${text}" as a Date`);
  return value;
}

function setClock(
  value: Date,
  [hours, minutes, seconds, fraction]: readonly (string | undefined)[],
  [sign, offsetHours, offsetMinutes, offsetSeconds]: readonly (string | undefined)[],
): void {
  // Subtracting the offset here, not from a finished Date, keeps a local time past a Date's range
  // readable when its instant is inside it.
  const direction = sign === "-" ? -1 : 1;
  value.setUTCHours(
    Number(hours) - direction * Number(offsetHours ?? 0),
    Number(minutes) - direction * Number(offsetMinutes ?? 0),
    Number(seconds) - direction * Number(offsetSeconds ?? 0),
    Number((fraction ?? "").padEnd(3, "0").slice(0, 3)),
  );
}

// A string passes through for Postgres to read, which is how postgresJsDriver sends a Date.
const timestamp: postgres.PostgresType<Date> = {
  to: 1114,
  from: [1114],
  serialize: (value: Date | string) => (typeof value === "string" ? value : formatTimestamp(value)),
  parse: parseTimestamp,
};

// A string passes through too. A number reads as postgres.js's own timestamptz serializer reads it.
const timestamptz: postgres.PostgresType<Date> = {
  to: 1184,
  from: [1184],
  serialize: (value: Date | string | number) =>
    typeof value === "string"
      ? value
      : formatTimestamp(value instanceof Date ? value : new Date(value)),
  parse: parseTimestamp,
};

const bytea: postgres.PostgresType<Uint8Array> = {
  to: 17,
  from: [17],
  serialize: (value) => `\\x${Buffer.from(value).toString("hex")}`,
  parse: (text: string) => {
    if (!text.startsWith("\\x")) throw new Error(`Can't read bytea "${text}" as hex`);
    return Uint8Array.from(Buffer.from(text.slice(2), "hex"));
  },
};

/**
 * The postgres.js `types` option that gives columns the Definition's value types: bigint as
 * `bigint`, date as the `YYYY-MM-DD` string (`YYYY-MM-DD BC`, `infinity`, and `-infinity` pass
 * through as Postgres writes them), timestamp and timestamptz as a `Date`, and bytea as a plain
 * `Uint8Array`. Reading a timestamp of `infinity`, `-infinity`, or past a Date's range throws.
 * Pass it with `postgresJsConnection`: `postgres(url, { types: postgresJsTypes, connection: postgresJsConnection })`.
 */
export const postgresJsTypes: {
  readonly bigint: postgres.PostgresType<bigint>;
  readonly date: postgres.PostgresType<string>;
  readonly timestamp: postgres.PostgresType<Date>;
  readonly timestamptz: postgres.PostgresType<Date>;
  readonly bytea: postgres.PostgresType<Uint8Array>;
} = { bigint, date, timestamp, timestamptz, bytea };

/**
 * The postgres.js `connection` option that `postgresJsTypes` reads by. It sends the output
 * settings at startup, which override the database's and role's defaults. `DateStyle: "ISO"`
 * names no date order, so a database-level `DMY` falls back to the server default (`MDY`). That
 * changes only how raw SQL reads an ambiguous date such as `'04/03/2024'`; spread this and set
 * `DateStyle: "ISO, DMY"` to keep the order.
 */
export const postgresJsConnection: { readonly DateStyle: "ISO"; readonly bytea_output: "hex" } = {
  DateStyle: "ISO",
  bytea_output: "hex",
};

export function hasPostgresJsTypes(parsers: Record<number, unknown>): boolean {
  return (
    parsers[bigint.to] === bigint.parse &&
    parsers[date.to] === date.parse &&
    parsers[timestamp.to] === timestamp.parse &&
    parsers[timestamptz.to] === timestamptz.parse &&
    parsers[bytea.to] === bytea.parse
  );
}

/**
 * Postgres reads setting names in any case and applies startup parameters in order, so a later
 * `datestyle` from the URL's query overrides an earlier `DateStyle`.
 */
export function hasPostgresJsConnection(connection: Record<string, unknown>): boolean {
  const settings = new Map(
    Object.entries(connection).map(([name, value]) => [
      name.toLowerCase(),
      String(value).toLowerCase(),
    ]),
  );
  const dateStyle =
    settings
      .get("datestyle")
      ?.split(",")
      .map((part) => part.trim()) ?? [];
  return dateStyle.includes("iso") && settings.get("bytea_output") === "hex";
}
