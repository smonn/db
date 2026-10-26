/**
 * An enum without its name or schema, which sits in a schema's object beside its tables and takes
 * its name from the key. `definitionCatalog` checks the labels, so an invalid enum fails at
 * generate rather than at load.
 */
export type Enum<L extends readonly string[] = readonly string[]> = {
  readonly kind: "enum";
  /** In the order Postgres sorts them, which is the order the enum compares in. */
  readonly labels: L;
  /** The SQL name the enum had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
  /** The labels renamed since the last migration, keyed new to old. */
  readonly renamedLabels: Readonly<Record<string, string>>;
};

export type EnumOptions<L extends readonly string[] = readonly string[]> = {
  /** The enum's SQL name before this change; generate ignores it once the old name is gone. */
  readonly renamedFrom?: string;
  /** Each renamed label, keyed by its new label; generate ignores one whose old label is gone. */
  readonly renamedLabels?: { readonly [K in L[number]]?: string };
};

export function defineEnum<const L extends readonly string[]>(
  labels: L,
  options: EnumOptions<L> = {},
): Enum<L> {
  return {
    kind: "enum",
    labels,
    renamedFrom: options.renamedFrom,
    renamedLabels: { ...options.renamedLabels },
  };
}

export function isEnum(value: unknown): value is Enum {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "enum";
}
