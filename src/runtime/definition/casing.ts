/** How `defineDatabase` maps a key to its SQL name; without one, a key is its SQL name. */
export type Casing = "snake_case";

export type DatabaseOptions = {
  /**
   * Maps schema, table, column, enum, and domain keys to SQL names, such as `userId` to `user_id`.
   * Enum labels and the names given to constraints, indexes, and domain checks stay verbatim.
   */
  readonly casing?: Casing;
};

const OPTION_KEYS = new Set(["casing"]);

/** The function that maps a key to its SQL name under `options`. */
export function casingOf(options: unknown): (key: string) => string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("defineDatabase takes its options as { casing? }");
  }
  const unexpected = Object.keys(options).find((key) => !OPTION_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`defineDatabase does not take the option "${unexpected}"`);
  }
  const casing: unknown = "casing" in options ? options.casing : undefined;
  if (casing === undefined) return (key) => key;
  if (casing === "snake_case") return snakeCase;
  throw new TypeError(`defineDatabase takes casing "snake_case", not ${JSON.stringify(casing)}`);
}

/**
 * `userId` to `user_id`, `HTTPServer` to `http_server`, `line2Text` to `line2_text`: an underscore
 * goes before each capital that follows a lowercase letter or digit, or that starts a word after
 * capitals, and then everything lowercases. A key already in snake_case stays as it is. A
 * plural acronym splits before its last capital, so `userIDs` maps to `user_i_ds`; give such a
 * key its own name.
 */
export function snakeCase(key: string): string {
  return key
    .replaceAll(/(?<=[\p{Ll}\d])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu, "_")
    .toLowerCase();
}
