export const HAZARD_KINDS = ["data_loss", "rewrite", "access_exclusive_lock"] as const;

export type HazardKind = (typeof HAZARD_KINDS)[number];

/** A risk one generated statement carries, which generate returns so the CLI can print and gate it. */
export type Hazard = {
  readonly kind: HazardKind;
  /** The statement the hazard comes from, without its `-- hazard:` comments. */
  readonly statement: string;
};

/** A rewrite holds ACCESS EXCLUSIVE while it copies the table, so it carries both kinds. */
export const REWRITE: readonly HazardKind[] = ["rewrite", "access_exclusive_lock"];
/**
 * Every `ALTER TABLE` takes ACCESS EXCLUSIVE, but only a scan or an index build holds it for
 * work that grows with the table, so only those carry the kind.
 */
export const LONG_LOCK: readonly HazardKind[] = ["access_exclusive_lock"];

type Type =
  | { readonly name: "character varying"; readonly length: number | undefined }
  | { readonly name: "numeric"; readonly precision: number | undefined; readonly scale: number }
  | { readonly name: SimpleName };

const SIMPLE_NAMES = [
  "text",
  "smallint",
  "integer",
  "bigint",
  "real",
  "double precision",
  "boolean",
  "uuid",
  "date",
  "timestamp without time zone",
  "timestamp with time zone",
  "jsonb",
  "bytea",
] as const;

type SimpleName = (typeof SIMPLE_NAMES)[number];

/** Reads a type as `format_type` spells it, or `undefined` for one v0.1 doesn't classify. */
function parse(type: string): Type | undefined {
  const varchar = /^character varying(?:\((\d+)\))?$/u.exec(type);
  if (varchar !== null) {
    return { name: "character varying", length: toNumber(varchar[1]) };
  }
  const numeric = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/u.exec(type);
  if (numeric !== null) {
    return { name: "numeric", precision: toNumber(numeric[1]), scale: toNumber(numeric[2]) ?? 0 };
  }
  const name = SIMPLE_NAMES.find((simple) => simple === type);
  return name === undefined ? undefined : { name };
}

function toNumber(digits: string | undefined): number | undefined {
  return digits === undefined ? undefined : Number(digits);
}

/**
 * The hazards of `alter column ... type` from `before` to `after`, with no `USING`. A type v0.1
 * doesn't classify gets every hazard, since only a gate can say it is safe.
 */
export function retypeHazards(before: string, after: string): readonly HazardKind[] {
  const from = parse(before);
  const to = parse(after);
  if (from === undefined || to === undefined) return HAZARD_KINDS;
  return [
    ...(losesData(from, to) ? (["data_loss"] as const) : []),
    ...(rewrites(from, to) ? REWRITE : []),
  ];
}

/**
 * Only the pairs Postgres converts in place without touching the rows skip the rewrite. Every
 * other pair rewrites, including `timestamp` and `timestamptz`, which skip it only when the
 * migrating session's time zone is UTC.
 */
function rewrites(from: Type, to: Type): boolean {
  if (from.name === "character varying") {
    if (to.name === "text") return false;
    if (to.name === "character varying") {
      return !(to.length === undefined || (from.length !== undefined && to.length >= from.length));
    }
  }
  if (from.name === "text" && to.name === "character varying") return to.length !== undefined;
  if (from.name === "numeric" && to.name === "numeric") {
    if (to.precision === undefined) return false;
    return !(
      from.precision !== undefined &&
      from.scale === to.scale &&
      to.precision >= from.precision
    );
  }
  return true;
}

const INTEGERS: ReadonlySet<string> = new Set(["smallint", "integer", "bigint"]);

/**
 * True when Postgres converts a value without an error but not back to what it was: rounding,
 * truncation, or lost precision. A conversion that fails on a value that doesn't fit, such as
 * `bigint` to `integer` or `text` to `varchar(5)`, loses nothing, since the statement rolls back.
 */
function losesData(from: Type, to: Type): boolean {
  if (INTEGERS.has(from.name)) {
    if (to.name === "real") return from.name !== "smallint";
    if (to.name === "double precision") return from.name === "bigint";
    return false;
  }
  if (from.name === "numeric") {
    const wholeNumbers = from.precision !== undefined && from.scale === 0;
    if (INTEGERS.has(to.name)) return !wholeNumbers;
    // Precision of a float: 6 decimal digits for real, 15 for double precision.
    if (to.name === "real") return from.precision === undefined || from.precision > 6;
    if (to.name === "double precision") return from.precision === undefined || from.precision > 15;
    if (to.name === "numeric") {
      if (to.precision === undefined) return false;
      return from.precision === undefined || to.scale < from.scale;
    }
    return false;
  }
  if (from.name === "real" || from.name === "double precision") {
    if (INTEGERS.has(to.name) || to.name === "numeric") return true;
    return from.name === "double precision" && to.name === "real";
  }
  if (from.name === "timestamp without time zone" || from.name === "timestamp with time zone") {
    return to.name === "date";
  }
  return false;
}
