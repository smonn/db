/**
 * An enum without its name or schema, which sits in a schema's object beside its tables and takes
 * its name from the key. `definitionCatalog` checks the labels, so an invalid enum fails at
 * generate rather than at load.
 */
export type Enum<L extends readonly string[] = readonly string[]> = {
  readonly kind: "enum";
  /** In the order Postgres sorts them, which is the order the enum compares in. */
  readonly labels: L;
};

export function defineEnum<const L extends readonly string[]>(labels: L): Enum<L> {
  return { kind: "enum", labels };
}

export function isEnum(value: unknown): value is Enum {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "enum";
}
