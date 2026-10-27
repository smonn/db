import { formatTimestamp } from "../../runtime/internal/index.ts";

// Postgres gives an untyped param the type of the first place it is compared or assigned. A Date
// goes out as untyped UTC text, so a `timestamp` column keeps its UTC wall clock in any session
// zone (#180). Two things then need help: an array of Dates, which postgres.js would type as a
// scalar `timestamptz`, and a param used against both `timestamp` and `timestamptz`, which
// Postgres types as the first and converts for the second in the session zone (#192).

function leaves(value: readonly unknown[]): unknown[] {
  return value.flatMap((item) => (Array.isArray(item) ? leaves(item) : [item]));
}

function arrayLiteral(value: readonly unknown[], number: number): string {
  const items = value.map((item) => {
    if (Array.isArray(item)) return arrayLiteral(item, number);
    if (item === null) return "NULL";
    if (item instanceof Date) return `"${formatTimestamp(item)}"`;
    throw new TypeError(`Param $${number} mixes Dates with other values in an array`);
  });
  return `{${items.join(",")}}`;
}

function dateText(value: unknown, number: number): string | undefined {
  if (value instanceof Date) return formatTimestamp(value);
  if (!Array.isArray(value) || !leaves(value).some((item) => item instanceof Date)) {
    return undefined;
  }
  return arrayLiteral(value, number);
}

// Comments, quoted strings and names, words, `$n`, a dollar-quote tag, or any other character.
const tokens = () =>
  /--[^\n]*|\/\*|[eE]'(?:[^'\\]|\\[^]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*|\$(\d+)|\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$|[^]/uy;

function endOfBlockComment(text: string, from: number): number {
  let depth = 1;
  let index = from;
  while (depth > 0 && index < text.length) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

// Returns the text a token covers, moving the scan past a block comment or a dollar-quoted string.
function copyToken(text: string, token: string, start: number, scan: RegExp): string {
  if (token === "/*") {
    scan.lastIndex = endOfBlockComment(text, scan.lastIndex);
  } else if (token.length > 1 && token.startsWith("$")) {
    const close = text.indexOf(token, scan.lastIndex);
    scan.lastIndex = close === -1 ? text.length : close + token.length;
  } else {
    return token;
  }
  return text.slice(start, scan.lastIndex);
}

// Gives every use of a Date param after the first a param of its own, holding the same value.
// Returns undefined when the text uses a param that doesn't exist, so Postgres refuses it as sent.
function splitDateUses(
  text: string,
  values: unknown[],
  isDate: readonly boolean[],
): string | undefined {
  const scan = tokens();
  const seen = new Set<number>();
  const count = values.length;
  let result = "";
  let highest = 0;
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    const [token, digits] = match;
    if (digits === undefined) {
      result += copyToken(text, token, match.index, scan);
    } else {
      const number = Number(digits);
      highest = Math.max(highest, number);
      if (isDate[number - 1] === true && seen.has(number)) {
        values.push(values[number - 1]);
        result += `$${values.length}`;
      } else {
        seen.add(number);
        result += token;
      }
    }
  }
  if (highest > count) {
    values.length = count;
    return undefined;
  }
  return result;
}

/**
 * Turns each Date param into untyped UTC text, an array of Dates into an untyped array literal,
 * and a Date param the text uses more than once into one param per use. Each use then takes the
 * type of its own context, such as `timestamp` for one and `timestamptz` for the other.
 */
export function bindDateParams(
  text: string,
  params: readonly unknown[],
): { text: string; values: unknown[] } {
  const isDate: boolean[] = [];
  const values = params.map((value, index) => {
    const bound = dateText(value, index + 1);
    isDate.push(bound !== undefined);
    return bound ?? value;
  });
  if (!isDate.includes(true)) return { text, values };
  return { text: splitDateUses(text, values, isDate) ?? text, values };
}
