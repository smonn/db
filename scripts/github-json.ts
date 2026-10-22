/**
 * Typed readers for the GitHub JSON that scripts parse (`gh` output, Actions event payloads).
 * `JSON.parse` returns `any`; `parseJson` narrows it to `unknown`, and each reader checks one
 * shape and throws an error naming the path of the first bad field. A caller builds its typed
 * object from `field` reads, so it holds only what it validated.
 */

export type Reader<T> = (value: unknown, path: string) => T;

export function parseJson(text: string, source: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${error instanceof Error ? error.message : "?"})`, {
      cause: error,
    });
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function mismatch(path: string, expected: string, value: unknown): Error {
  return new Error(`${path}: expected ${expected}, got ${describeType(value)}`);
}

export const string: Reader<string> = (value, path) => {
  if (typeof value !== "string") throw mismatch(path, "string", value);
  return value;
};

export const number: Reader<number> = (value, path) => {
  if (typeof value !== "number") throw mismatch(path, "number", value);
  return value;
};

export function literal<const T extends string>(...allowed: T[]): Reader<T> {
  return (value, path) => {
    const match = allowed.find((candidate) => candidate === value);
    if (match === undefined) throw mismatch(path, allowed.map((a) => `"${a}"`).join(" | "), value);
    return match;
  };
}

export function array<T>(item: Reader<T>): Reader<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw mismatch(path, "array", value);
    return value.map((element: unknown, index) => item(element, `${path}[${index}]`));
  };
}

export const record: Reader<Record<string, unknown>> = (value, path) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw mismatch(path, "object", value);
  }
  return Object.fromEntries(Object.entries(value));
};

/** Reads `key` of an already-checked record; a missing key reads as `undefined`. */
export function field<T>(
  source: Record<string, unknown>,
  key: string,
  read: Reader<T>,
  path: string,
): T {
  return read(source[key], `${path}.${key}`);
}

/** Reads a key that may be absent; present values must pass `read`. */
export function optionalField<T>(
  source: Record<string, unknown>,
  key: string,
  read: Reader<T>,
  path: string,
): T | undefined {
  return source[key] === undefined ? undefined : field(source, key, read, path);
}
