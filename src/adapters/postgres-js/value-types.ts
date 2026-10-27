import type postgres from "postgres";
import {
  elementText,
  formatArrayLiteral,
  formatTimestamp,
  parseArrayLiteral,
  type ArrayValue,
} from "../../runtime/internal/index.ts";

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

type ArrayType<T> = postgres.PostgresType<ArrayValue<T>>;

// Array text a query layer already wrote passes through; a JS array is written here, once
// Postgres has typed the param it fills. postgres.js's `fetch_types` skips an array type that has
// both a parser and a serializer, so these stay in place for every built-in array.
function arrayType<T>(
  oids: readonly [number, ...number[]],
  parseElement: (text: string) => T,
  { formatElement = elementText, delimiter = "," } = {},
): ArrayType<T> {
  return {
    to: oids[0],
    from: [...oids],
    serialize: (value: readonly unknown[] | string) =>
      typeof value === "string" ? value : formatArrayLiteral(value, formatElement, delimiter),
    parse: (text: string) => parseArrayLiteral(text, parseElement, delimiter),
  };
}

const asText = (text: string): string => text;

// The built-in array types, by OID, whose elements read as text: every one but those below.
const textArrayOids = [
  1009, 143, 210, 270, 271, 272, 273, 629, 651, 719, 775, 791, 1002, 1003, 1006, 1008, 1010, 1011,
  1012, 1013, 1014, 1015, 1017, 1018, 1019, 1027, 1034, 1040, 1041, 1183, 1187, 1231, 1263, 1270,
  1561, 1563, 2201, 2207, 2208, 2209, 2210, 2211, 2287, 2949, 2951, 3221, 3643, 3644, 3645, 3735,
  3770, 3905, 3907, 3909, 3911, 3913, 3927, 4073, 4090, 4097, 4192, 5039, 6150, 6151, 6152, 6153,
  6155, 6157,
] as const;

const arrays = {
  textArray: arrayType(textArrayOids, asText),
  // int2, int4, oid, float4, and float8, which postgres.js reads as numbers.
  numberArray: arrayType([1007, 1005, 1028, 1021, 1022], Number),
  booleanArray: arrayType([1000], (text) => text === "t"),
  jsonArray: arrayType([3807, 199], (text): unknown => JSON.parse(text), {
    formatElement: (element) => JSON.stringify(element),
  }),
  bigintArray: arrayType([1016], bigint.parse),
  dateArray: arrayType([1182], date.parse),
  timestampArray: arrayType([1115], parseTimestamp),
  timestamptzArray: arrayType([1185], parseTimestamp),
  byteaArray: arrayType([1001], bytea.parse),
  // A box holds commas, so a box array is the one built-in array that splits on `;`.
  boxArray: arrayType([1020], asText, { delimiter: ";" }),
};

/**
 * The postgres.js `types` option that gives columns the Definition's value types: bigint as
 * `bigint`, date as the `YYYY-MM-DD` string (`YYYY-MM-DD BC`, `infinity`, and `-infinity` pass
 * through as Postgres writes them), timestamp and timestamptz as a `Date`, and bytea as a plain
 * `Uint8Array`. Reading a timestamp of `infinity`, `-infinity`, or past a Date's range throws.
 * Every built-in array type reads as an array of those values, with a NULL element as `null`.
 * Pass an array parameter as a plain JS array. Don't use postgres.js's `sql.array()`: it skips
 * these OIDs, so it types the parameter as the scalar element (`sql.array([1n, 2n])` throws).
 * Pass it with `postgresJsConnection`: `postgres(url, { types: postgresJsTypes, connection: postgresJsConnection })`.
 */
export const postgresJsTypes: {
  readonly bigint: postgres.PostgresType<bigint>;
  readonly date: postgres.PostgresType<string>;
  readonly timestamp: postgres.PostgresType<Date>;
  readonly timestamptz: postgres.PostgresType<Date>;
  readonly bytea: postgres.PostgresType<Uint8Array>;
  readonly textArray: ArrayType<string>;
  readonly numberArray: ArrayType<number>;
  readonly booleanArray: ArrayType<boolean>;
  readonly jsonArray: ArrayType<unknown>;
  readonly bigintArray: ArrayType<bigint>;
  readonly dateArray: ArrayType<string>;
  readonly timestampArray: ArrayType<Date>;
  readonly timestamptzArray: ArrayType<Date>;
  readonly byteaArray: ArrayType<Uint8Array>;
  readonly boxArray: ArrayType<string>;
} = { bigint, date, timestamp, timestamptz, bytea, ...arrays };

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
    parsers[bytea.to] === bytea.parse &&
    Object.values(arrays).every((type) => type.from.every((oid) => parsers[oid] === type.parse))
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
