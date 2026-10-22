import type postgres from "postgres";

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
  const [
    ,
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    fraction = "",
    sign,
    offsetHours,
    offsetMinutes,
    offsetSeconds,
    bc,
  ] = match;
  const value = new Date(0);
  // Date.UTC reads years 0 to 99 as 1900 to 1999; setUTCFullYear doesn't. 1 BC is year 0.
  value.setUTCFullYear(
    bc === undefined ? Number(year) : 1 - Number(year),
    Number(month) - 1,
    Number(day),
  );
  value.setUTCHours(
    Number(hours),
    Number(minutes),
    Number(seconds),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  const offset =
    (Number(offsetHours ?? 0) * 3600 +
      Number(offsetMinutes ?? 0) * 60 +
      Number(offsetSeconds ?? 0)) *
    1000;
  const parsed = new Date(value.getTime() - (sign === "-" ? -offset : offset));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Can't read timestamp "${text}" as a Date`);
  return parsed;
}

// toISOString writes BC and five-digit years as `-000043` and `+010000`, which Postgres refuses.
// A timestamp ignores the `+00`, and a timestamptz reads the instant in UTC.
function formatTimestamp(value: Date): string {
  const iso = value.toISOString();
  const time = iso.indexOf("T");
  const year = value.getUTCFullYear();
  const era = year > 0 ? "" : " BC";
  return `${String(year > 0 ? year : 1 - year).padStart(4, "0")}${iso.slice(time - 6, time)} ${iso.slice(time + 1, -1)}+00${era}`;
}

const timestamp: postgres.PostgresType<Date> = {
  to: 1114,
  from: [1114],
  serialize: formatTimestamp,
  parse: parseTimestamp,
};

// postgres.js sends every Date param as a timestamptz, so this serializer writes both columns.
// It takes other values as postgres.js's own timestamptz serializer does.
const timestamptz: postgres.PostgresType<Date> = {
  to: 1184,
  from: [1184],
  serialize: (value: Date | string | number) =>
    formatTimestamp(value instanceof Date ? value : new Date(value)),
  parse: parseTimestamp,
};

const hexBytea = /^\\x(?:[\da-f]{2})*$/u;

const bytea: postgres.PostgresType<Uint8Array> = {
  to: 17,
  from: [17],
  serialize: (value) => `\\x${Buffer.from(value).toString("hex")}`,
  parse: (text: string) => {
    if (!hexBytea.test(text)) throw new Error(`Can't read bytea "${text}" as hex`);
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
 * settings at startup, which override the database's and role's defaults.
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
