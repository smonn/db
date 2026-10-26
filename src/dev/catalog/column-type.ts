import type { Enum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";

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

/**
 * A column's type as `format_type` renders it. An enum column holds the enum itself, which
 * `enums` names by the key it sits under; `column` locates the column in the error for an enum
 * the Definition never rolled up.
 */
export function columnType(
  { sqlType, enumType }: { readonly sqlType: string; readonly enumType: Enum | undefined },
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
 * quoted only where `quote_identifier` would. It leaves keywords unquoted, which Postgres quotes.
 */
export function typeName(schema: string, name: string): string {
  return [schema, name]
    .map((part) => (/^[a-z_][a-z0-9_]*$/u.test(part) ? part : quoteIdentifier(part)))
    .join(".");
}
