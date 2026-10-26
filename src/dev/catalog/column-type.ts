import type { Domain, Enum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { quoted } from "./catalog.ts";
import { QUOTED_KEYWORDS } from "./keywords.ts";

const TYPE_NAMES: Readonly<Record<string, string>> = {
  varchar: "character varying",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
};

/** Rewrites the Definition's `sqlType` the way `format_type` renders it, so both catalogs agree. */
function postgresType(sqlType: string): string {
  const [name = sqlType, modifiers = ""] = sqlType.split(/(?=\()/u);
  // Postgres reads `numeric(10)` back as `numeric(10,0)`.
  const spelled =
    name === "numeric" && /^\(\d+\)$/u.test(modifiers)
      ? `(${modifiers.slice(1, -1)},0)`
      : modifiers;
  return `${TYPE_NAMES[name] ?? name}${spelled}`;
}

const ARRAY_SUFFIX = "[]";

/**
 * The array of a type, spelled as `format_type` does: `[]` after the element, whatever its
 * modifiers or quoting. Postgres shows no dimensions, so every array is one-dimensional here.
 */
export function arrayType(element: string): string {
  return `${element}${ARRAY_SUFFIX}`;
}

/** The element of an array type spelled by `arrayType`, or `undefined` for any other type. */
export function elementOf(type: string): string | undefined {
  return type.endsWith(ARRAY_SUFFIX) ? type.slice(0, -ARRAY_SUFFIX.length) : undefined;
}

/** The Definition's enums and domains, each named by the key it sits under. */
export type TypeNames = {
  readonly enums: ReadonlyMap<Enum, string>;
  readonly domains: ReadonlyMap<Domain, string>;
};

type Typed = {
  readonly sqlType: string;
  readonly enumType: Enum | undefined;
  readonly domainType?: Domain | undefined;
};

/**
 * A column's type as `format_type` renders it. An enum or domain column holds the type itself,
 * which `names` names; `owner`, such as `Column "public"."t"."x"`, starts the error for a type
 * the Definition never rolled up.
 */
export function columnType(
  state: Typed & { readonly array: boolean },
  names: TypeNames,
  owner: string,
): string {
  const element = elementType(state, names, owner);
  return state.array ? arrayType(element) : element;
}

/** A domain's base or a column's element type, as `format_type` renders it. */
export function elementType(
  { sqlType, enumType, domainType }: Typed,
  names: TypeNames,
  owner: string,
): string {
  if (enumType !== undefined) return rolledUp(names.enums.get(enumType), owner, "an enum");
  if (domainType !== undefined) return rolledUp(names.domains.get(domainType), owner, "a domain");
  return postgresType(sqlType);
}

function rolledUp(type: string | undefined, owner: string, noun: string): string {
  if (type === undefined) {
    throw new Error(
      `${owner} uses ${noun} that is not in the Definition; roll it up beside the tables in a schema`,
    );
  }
  return type;
}

/**
 * Each enum or domain's type name, found by the identity of the value its columns hold. Throws for
 * one value rolled up under two names.
 */
export function typeNamesOf<T extends object>(
  definition: { readonly [schema: string]: { readonly [name: string]: unknown } },
  is: (entry: unknown) => entry is T,
  define: "defineEnum" | "defineDomain",
): ReadonlyMap<T, string> {
  const found = new Map<T, readonly [schema: string, name: string]>();
  for (const [schema, entries] of Object.entries(definition)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (!is(entry)) continue;
      const other = found.get(entry);
      if (other !== undefined) {
        const noun = define === "defineEnum" ? "enum" : "domain";
        throw new Error(
          `One ${noun} is rolled up as ${quoted(other)} and ${quoted([schema, name])}; give each its own ${define}`,
        );
      }
      found.set(entry, [schema, name]);
    }
  }
  return new Map([...found].map(([entry, [schema, name]]) => [entry, typeName(schema, name)]));
}

/**
 * A type's name as `format_type` spells it under `search_path = pg_catalog`: schema-qualified, and
 * quoted exactly where `quote_ident` would, which includes a keyword that is not unreserved.
 */
export function typeName(schema: string, name: string): string {
  return [schema, name]
    .map((part) =>
      /^[a-z_][a-z0-9_]*$/u.test(part) && !QUOTED_KEYWORDS.has(part) ? part : quoteIdentifier(part),
    )
    .join(".");
}
