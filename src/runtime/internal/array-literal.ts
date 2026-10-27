import { formatTimestamp } from "./timestamp-text.ts";

/** An array as Postgres writes it: elements, NULLs, and nested arrays for more dimensions. */
export type ArrayValue<T> = (T | null | ArrayValue<T>)[];

type Cursor = { readonly text: string; at: number };

function malformed(text: string): Error {
  return new Error(`Can't read array ${JSON.stringify(text)}`);
}

function quoted(cursor: Cursor): string {
  const { text } = cursor;
  let value = "";
  cursor.at += 1;
  for (let char = text[cursor.at]; char !== undefined; char = text[cursor.at]) {
    cursor.at += 1;
    if (char === '"') return value;
    if (char === "\\") {
      value += text.charAt(cursor.at);
      cursor.at += 1;
    } else {
      value += char;
    }
  }
  throw malformed(text);
}

function unquoted(cursor: Cursor, delimiter: string): { raw: string; value: string } {
  const { text } = cursor;
  let value = "";
  const start = cursor.at;
  for (
    let char = text[cursor.at];
    char !== undefined && char !== delimiter && char !== "}";
    char = text[cursor.at]
  ) {
    if (char === "\\") cursor.at += 1;
    value += text.charAt(cursor.at);
    cursor.at += 1;
  }
  return { raw: text.slice(start, cursor.at).trim(), value: value.trim() };
}

function skipSpace(cursor: Cursor): void {
  while (/\s/u.test(cursor.text.charAt(cursor.at))) cursor.at += 1;
}

function element<T>(
  cursor: Cursor,
  parseElement: (text: string) => T,
  delimiter: string,
): T | null | ArrayValue<T> {
  const char = cursor.text[cursor.at];
  if (char === "{") return list(cursor, parseElement, delimiter);
  if (char === '"') return parseElement(quoted(cursor));
  const { raw, value } = unquoted(cursor, delimiter);
  if (raw === "") throw malformed(cursor.text);
  return raw.toUpperCase() === "NULL" ? null : parseElement(value);
}

function list<T>(
  cursor: Cursor,
  parseElement: (text: string) => T,
  delimiter: string,
): ArrayValue<T> {
  const { text } = cursor;
  if (text[cursor.at] !== "{") throw malformed(text);
  cursor.at += 1;
  skipSpace(cursor);
  const items: ArrayValue<T> = [];
  if (text[cursor.at] === "}") {
    cursor.at += 1;
    return items;
  }
  for (;;) {
    skipSpace(cursor);
    items.push(element(cursor, parseElement, delimiter));
    skipSpace(cursor);
    const next = text[cursor.at];
    cursor.at += 1;
    if (next === "}") return items;
    if (next !== delimiter) throw malformed(text);
  }
}

/**
 * Reads array text as Postgres writes it. An unquoted `NULL` is null, and every other element
 * goes through `parseElement`, so a quoted `"NULL"` stays text. `box` arrays split on `;`.
 */
export function parseArrayLiteral<T>(
  text: string,
  parseElement: (text: string) => T,
  delimiter = ",",
): ArrayValue<T> {
  // A lower bound other than 1 comes first, as in `[0:1]={a,b}`.
  const bounds = text.startsWith("[") ? text.indexOf("=") + 1 : 0;
  const cursor: Cursor = { text, at: bounds };
  const value = list(cursor, parseElement, delimiter);
  skipSpace(cursor);
  if (cursor.at !== text.length) throw malformed(text);
  return value;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The text Postgres reads an element from, following ADR-0010's mapping back: a Date as UTC
 * timestamp text, bytes as `\x` hex, a boolean as `t` or `f`, and an object as JSON.
 */
export function elementText(value: unknown): string {
  return typeof value === "object" && value !== null ? objectText(value) : primitiveText(value);
}

function objectText(value: object): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("An array element is an Invalid Date");
    return formatTimestamp(value);
  }
  if (value instanceof Uint8Array) return `\\x${hex(value)}`;
  return JSON.stringify(value);
}

function primitiveText(value: unknown): string {
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  throw new TypeError(`An array element is a ${typeof value}`);
}

function quote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Writes array-literal text that Postgres reads as any array type, so the server types it from
 * where it is used. Every element is quoted, and null is `NULL`.
 */
export function formatArrayLiteral(
  value: readonly unknown[],
  formatElement: (element: unknown) => string = elementText,
  delimiter = ",",
): string {
  const items = value.map((item) => {
    if (Array.isArray(item)) return formatArrayLiteral(item, formatElement, delimiter);
    if (item === null) return "NULL";
    if (item === undefined) throw new TypeError("An array element is undefined");
    return quote(formatElement(item));
  });
  return `{${items.join(delimiter)}}`;
}
