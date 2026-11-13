import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../../runtime/ports/index.ts";
import { useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

type Column = {
  readonly type: string;
  readonly value: fc.Arbitrary<unknown>;
  /** The values an array element takes, when that is narrower than a param's. */
  readonly element?: fc.Arbitrary<unknown>;
  /** Maps what is read to the closest value the type holds, when it can't hold the input exactly. */
  readonly settle?: (value: unknown) => unknown;
  /** Output settings change how Postgres writes it, so it also runs under non-default ones. */
  readonly output?: boolean;
};

// A year past a Date's range, or before 4713 BC, is outside what a timestamp holds.
const earliest = new Date("-004712-01-01T00:00:00Z");
const latest = new Date(8.64e15);
const instants = fc.date({ min: earliest, max: latest, noInvalidDate: true });

const zones = fc.constantFrom(
  "UTC",
  "Asia/Tokyo",
  "America/New_York",
  "America/St_Johns",
  "Asia/Kathmandu",
  "Pacific/Kiritimati",
  "Etc/GMT+12",
);

const hostile = fc.string({
  unit: fc.constantFrom(
    "{",
    "}",
    '"',
    ",",
    "\\",
    " ",
    "N",
    "U",
    "L",
    "'",
    "\n",
    "\t",
    ";",
    "(",
    ")",
  ),
});
const text = fc
  .oneof(
    fc.string({ unit: "grapheme", maxLength: 12 }),
    hostile,
    fc.constantFrom("", "NULL", "null", " ", "{}", '"', "\\", "é", "日本語", "😀", "a\nb"),
  )
  .filter((value) => !value.includes("\0"));

// Postgres leaves a non-ASCII space such as U+2000 unquoted in array text, and parseArrayLiteral
// trims leading and trailing non-ASCII whitespace, so an element that starts or ends with one
// reads back shortened, and one holding only that space reads back as an empty array.
const arrayText = text.filter((value) => !/^[^\S\t\n\v\f\r ]|[^\S\t\n\v\f\r ]$/u.test(value));

function day(value: Date): string {
  const iso = value.toISOString();
  const year = value.getUTCFullYear();
  const era = year > 0 ? "" : " BC";
  return `${String(year > 0 ? year : 1 - year).padStart(4, "0")}${iso.slice(iso.indexOf("T") - 6, iso.indexOf("T"))}${era}`;
}

function decimal(mantissa: bigint, scale: number): string {
  const digits = (mantissa < 0n ? -mantissa : mantissa).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  return `${mantissa < 0n ? "-" : ""}${whole}${scale === 0 ? "" : `.${digits.slice(-scale)}`}`;
}

// jsonb keeps neither key order nor a `\u0000`, and reads -0 as 0.
const json = fc
  .jsonValue()
  .filter((value) => !JSON.stringify(value).includes("\\u0000"))
  .map((value): unknown => JSON.parse(JSON.stringify(value)));

// postgres.js types a JS boolean param as bool, which Postgres won't assign to a jsonb column.
const jsonParam = json.filter((value) => typeof value !== "boolean");

// An element that is a JS array reads as another dimension of the array.
const jsonElement = json.filter((value) => !Array.isArray(value));

// A box Postgres returns as written when it lists the upper right corner first.
const box = fc
  .tuple(fc.integer(), fc.integer(), fc.nat(), fc.nat())
  .map(([x, y, width, height]) => `(${x + width},${y + height}),(${x},${y})`);

// postgres.js writes -0 as 0.
const floatParam = (value: fc.Arbitrary<number>): fc.Arbitrary<number> =>
  value.filter((number) => !Object.is(number, -0));

// A real holds a float32, so it reads back as the double that rounds to the value written.
const fround = (value: unknown): unknown =>
  typeof value === "number" ? Math.fround(value) : value;

const columns: readonly Column[] = [
  { type: "smallint", value: fc.integer({ min: -32768, max: 32767 }) },
  { type: "integer", value: fc.integer({ min: -2147483648, max: 2147483647 }) },
  { type: "bigint", value: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }) },
  {
    type: "numeric",
    value: fc.oneof(
      fc
        .tuple(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), fc.integer({ min: 0, max: 12 }))
        .map(([mantissa, scale]) => decimal(mantissa, scale)),
      fc.constantFrom("NaN", "Infinity", "-Infinity"),
    ),
  },
  { type: "real", value: floatParam(fc.float()), settle: fround },
  { type: "double precision", value: floatParam(fc.double()) },
  { type: "boolean", value: fc.boolean() },
  { type: "text", value: text, element: arrayText },
  { type: "varchar", value: text, element: arrayText },
  { type: "uuid", value: fc.uuid() },
  ...["jsonb", "json"].map((type) => ({ type, value: jsonParam, element: jsonElement })),
  { type: "oid", value: fc.nat(4294967295) },
  { type: "box", value: box },
  { type: "bytea", value: fc.uint8Array({ maxLength: 16 }), output: true },
  {
    type: "date",
    value: fc.oneof(
      instants.map((instant) => day(instant)),
      fc.constantFrom(
        "infinity",
        "-infinity",
        "4713-01-01 BC",
        "0001-12-31 BC",
        "0001-01-01",
        "5874897-12-31",
      ),
    ),
    output: true,
  },
  { type: "timestamp", value: instants, output: true },
  { type: "timestamptz", value: instants, output: true },
];

function list(element: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return fc.array(fc.option(element, { nil: null }), { maxLength: 6 });
}

// A rectangular two-dimensional array, which Postgres requires.
function grid(element: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return fc
    .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
    .chain(([rows, width]) =>
      fc.array(
        fc.array(fc.option(element, { nil: null }), { minLength: width, maxLength: width }),
        { minLength: rows, maxLength: rows },
      ),
    );
}

function deep(settle: (value: unknown) => unknown): (value: unknown) => unknown {
  return (value) => (Array.isArray(value) ? value.map(deep(settle)) : settle(value));
}

type Shape = {
  readonly name: string;
  readonly type: string;
  readonly value: fc.Arbitrary<unknown>;
  readonly settle: (value: unknown) => unknown;
  readonly output: boolean;
};

const shapes: readonly Shape[] = columns.flatMap((column) => {
  const { type, settle = (value: unknown): unknown => value, output = false } = column;
  const element = column.element ?? column.value;
  return [
    { name: type, type, value: fc.option(column.value, { nil: null }), settle, output },
    { name: `${type}[]`, type: `${type}[]`, value: list(element), settle: deep(settle), output },
    { name: `${type}[][]`, type: `${type}[]`, value: grid(element), settle: deep(settle), output },
  ];
});

const tables = new Map(shapes.map((shape, index) => [shape.name, `round_trip_${index}`]));

beforeAll(async () => {
  await db.driver.execute(
    shapes.map((shape) => `create table ${tables.get(shape.name)} (v ${shape.type});`).join("\n"),
  );
});

function roundTrip(driver: Driver, table: string, value: unknown, zone: string): Promise<unknown> {
  return driver.transaction(async (tx) => {
    await tx.execute(`set local time zone '${zone}'`);
    const { rows } = await tx.query(`insert into ${table} (v) values ($1) returning v`, [value]);
    return rows[0]?.["v"];
  });
}

function check(driver: () => Driver, only: (shape: Shape) => boolean): void {
  it.each(shapes.filter((shape) => only(shape)).map((shape) => [shape.name, shape] as const))(
    "reads %s back as written",
    async (_, shape) => {
      const table = tables.get(shape.name)!;
      await fc.assert(
        fc.asyncProperty(shape.value, zones, async (value, zone) => {
          const read = await roundTrip(driver(), table, value, zone);
          expect(shape.settle(read)).toStrictEqual(value);
        }),
        // Bounded so the file adds only seconds to the Test job; fast-check prints a failure's seed.
        { numRuns: 100 },
      );
    },
  );
}

describe("a value inserted through a bound parameter and selected back", () => {
  check(
    () => db.driver,
    () => true,
  );
});

describe("under database defaults that write dates and bytes another way", () => {
  let pool: Driver;
  beforeAll(async () => {
    await db.driver.execute(
      `alter database ${db.name} set datestyle = 'German, DMY'; alter database ${db.name} set bytea_output = 'escape'`,
    );
    pool = db.ownPool();
  });

  check(
    () => pool,
    (shape) => shape.output,
  );
});
