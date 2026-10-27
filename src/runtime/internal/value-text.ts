// How Postgres writes a value as text, read back as the Definition's TypeScript value. The
// postgres.js adapter and the query layer's enum and domain arrays share these.

const isoDate = /^(?:\d{4,}-\d\d-\d\d(?: BC)?|-?infinity)$/u;

export function parseDate(text: string): string {
  if (!isoDate.test(text)) throw new Error(`Can't read date "${text}" as YYYY-MM-DD`);
  return text;
}

// DateStyle ISO output: a year of four or more digits, up to six fraction digits, and for
// timestamptz an offset that can carry minutes and seconds, such as `+09:18:59` before 1888.
const isoTimestamp =
  /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:([+-])(\d\d)(?::(\d\d))?(?::(\d\d))?)?( BC)?$/u;

export function parseTimestamp(text: string): Date {
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

export function parseBytea(text: string): Uint8Array {
  if (!text.startsWith("\\x")) throw new Error(`Can't read bytea "${text}" as hex`);
  const bytes = new Uint8Array(Math.floor((text.length - 2) / 2));
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Number.parseInt(text.slice(2 + at * 2, 4 + at * 2), 16);
  }
  return bytes;
}
