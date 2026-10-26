export const INDEX_METHODS = ["btree", "hash", "gin", "gist", "brin"] as const;

export type IndexMethod = (typeof INDEX_METHODS)[number];

/** What `.index()` on a column takes; the second callback's `indexes` entry takes more. */
export type IndexOptions = {
  /** Replaces the derived name, `<table>_<column>_idx`. */
  readonly name?: string;
  /** Defaults to `"btree"`. */
  readonly method?: IndexMethod;
};

/** An index a column declares, before the catalog derives its name. */
export type ColumnIndex = {
  readonly name: string | undefined;
  readonly method: IndexMethod;
};

/** Narrows `given` to a method the Definition models, or throws naming `owner`. */
export function methodOf(given: unknown, owner: string): IndexMethod {
  if (given === undefined) return "btree";
  const method = INDEX_METHODS.find((candidate) => candidate === given);
  if (method !== undefined) return method;
  throw new TypeError(
    `${owner} takes the method ${INDEX_METHODS.map((m) => `"${m}"`).join(", ")}, not ${JSON.stringify(given)}`,
  );
}

/** Narrows `given` to a name string or `undefined`, or throws naming `owner`. */
export function indexNameOf(given: unknown, owner: string): string | undefined {
  if (given === undefined || typeof given === "string") return given;
  throw new TypeError(`${owner} takes its name as a string`);
}

/** The `.index()` options as state: unknown keys throw, so a typo never goes unnoticed. */
export function columnIndexOf(options: IndexOptions | undefined): ColumnIndex {
  const given: object = options ?? {};
  const unexpected = Object.keys(given).find((key) => key !== "name" && key !== "method");
  if (unexpected !== undefined) {
    throw new TypeError(`index() does not take "${unexpected}"; it takes { name, method }`);
  }
  return {
    name: indexNameOf("name" in given ? given.name : undefined, "index()"),
    method: methodOf("method" in given ? given.method : undefined, "index()"),
  };
}
