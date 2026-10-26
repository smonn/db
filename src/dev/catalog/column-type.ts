import type { Enum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
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

/**
 * A column's type as `format_type` renders it. An enum column holds the enum itself, which
 * `enums` names by the key it sits under; `column` locates the column in the error for an enum
 * the Definition never rolled up.
 */
export function columnType(
  {
    sqlType,
    enumType,
    array,
  }: { readonly sqlType: string; readonly enumType: Enum | undefined; readonly array: boolean },
  enums: ReadonlyMap<Enum, string>,
  column: string,
): string {
  const element = elementType(sqlType, enumType, enums, column);
  return array ? arrayType(element) : element;
}

function elementType(
  sqlType: string,
  enumType: Enum | undefined,
  enums: ReadonlyMap<Enum, string>,
  column: string,
): string {
  if (enumType === undefined) return postgresType(sqlType);
  const type = enums.get(enumType);
  if (type === undefined) {
    throw new Error(
      `Column ${column} uses an enum that is not in the Definition; roll it up beside the tables in a schema`,
    );
  }
  return type;
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
