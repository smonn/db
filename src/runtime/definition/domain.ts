import type { Enum } from "./enum.ts";

/** What a domain is over: a factory type or an enum, never an array or another domain. */
export type DomainBase = {
  /** Empty for an enum, whose type is `enumType`. */
  readonly sqlType: string;
  readonly enumType: Enum | undefined;
};

/**
 * A domain without its name or schema, which sits in a schema's object beside its tables and takes
 * its name from the key. `V` is its base's TypeScript value, and `N` is true when it is NOT NULL,
 * which makes each column of it non-null in `Row`.
 */
export type Domain<V = unknown, N extends boolean = boolean> = {
  readonly kind: "domain";
  readonly base: DomainBase;
  readonly notNull: boolean;
  /** The SQL name `options.name` gave, which wins over the casing `defineDatabase` maps keys with. */
  readonly name: string | undefined;
  /** A SQL expression, written as it would follow `default` in DDL. */
  readonly default: string | undefined;
  /** Each check's expression, where `value` names the value checked, keyed by its constraint name. */
  readonly checks: Readonly<Record<string, string>>;
  /** The SQL name the domain had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
  /** Type-only: the value a column of the domain holds, and whether the domain is NOT NULL. */
  readonly "~types": { readonly value: V; readonly notNull: N };
};

export function isDomain(value: unknown): value is Domain {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "domain";
}
