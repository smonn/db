import { elementOf } from "../catalog/index.ts";

export const HAZARD_KINDS = [
  "data_loss",
  "rewrite",
  "access_exclusive_lock",
  "share_lock",
  "share_row_exclusive_lock",
  "rename",
] as const;

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
 * Adding a foreign key to an existing table scans it while holding SHARE ROW EXCLUSIVE on it and
 * on the table it points at, which blocks writes but not reads.
 */
export const WRITE_LOCK: readonly HazardKind[] = ["share_row_exclusive_lock"];
/** Creating an index on an existing table holds SHARE on it, which blocks writes but not reads. */
export const INDEX_LOCK: readonly HazardKind[] = ["share_lock"];
/**
 * Every `ALTER TABLE` takes ACCESS EXCLUSIVE, but only a scan or an index build holds it for
 * work that grows with the table, so only those carry the kind.
 */
export const LONG_LOCK: readonly HazardKind[] = ["access_exclusive_lock"];

/** Adding a check or NOT NULL to a domain scans each column of it under SHARE (ADR-0021). */
export const DOMAIN_SCAN_LOCK: readonly HazardKind[] = ["share_lock"];

/** What `retypeHazards` reads of a domain. */
export type DomainType = {
  /** As `format_type` spells it, like a column's `type`. */
  readonly base: string;
  /** NOT NULL or with a check, so a value moving onto it has to be checked. */
  readonly constrained: boolean;
};

type Type =
  | { readonly name: "character varying"; readonly length: number | undefined }
  | { readonly name: "numeric"; readonly precision: number | undefined; readonly scale: number }
  | { readonly name: SimpleName }
  | { readonly name: "enum" };

type Varchar = Extract<Type, { readonly name: "character varying" }>;
type Numeric = Extract<Type, { readonly name: "numeric" }>;

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

/** Reads a scalar type as `format_type` spells it, or `undefined` for one the diff doesn't classify. */
function parse(type: string, enums: ReadonlySet<string>): Type | undefined {
  if (enums.has(type)) return { name: "enum" };
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

type NamedTypes = {
  readonly enums: ReadonlySet<string>;
  readonly domains: ReadonlyMap<string, DomainType>;
};

/**
 * The hazards of `alter column ... type` from `before` to `after`, with no `USING`. `enums` holds
 * the types spelled as enums, and `domains` each domain by its spelling. A type the diff doesn't
 * classify gets every hazard, since only a gate can say it is safe.
 */
export function retypeHazards(
  before: string,
  after: string,
  enums: ReadonlySet<string> = new Set(),
  domains: ReadonlyMap<string, DomainType> = new Map(),
): readonly HazardKind[] {
  return typeHazards(before, after, { enums, domains });
}

function typeHazards(before: string, after: string, named: NamedTypes): readonly HazardKind[] {
  const domain = domainRetypeHazards(before, after, named.domains);
  if (domain !== undefined) return domain;
  const fromElement = elementOf(before);
  const toElement = elementOf(after);
  if (fromElement !== undefined || toElement !== undefined) {
    return arrayRetypeHazards(fromElement, toElement, named);
  }
  const from = parse(before, named.enums);
  const to = parse(after, named.enums);
  if (from === undefined || to === undefined) return HAZARD_KINDS;
  return pairHazards(from, to);
}

/**
 * A domain's values read as its base, so from a domain to its base, or to an unconstrained domain
 * over the same base, changes nothing, and to a constrained one checks every row. Any other pair
 * with a domain gets every hazard; `undefined` when neither type is a domain.
 */
function domainRetypeHazards(
  before: string,
  after: string,
  domains: ReadonlyMap<string, DomainType>,
): readonly HazardKind[] | undefined {
  const source = domains.get(before);
  const target = domains.get(after);
  if (source === undefined && target === undefined) return undefined;
  return domainPairHazards(before, after, source, target);
}

function domainPairHazards(
  before: string,
  after: string,
  source: DomainType | undefined,
  target: DomainType | undefined,
): readonly HazardKind[] {
  const value = source === undefined ? before : source.base;
  if (target === undefined) return value === after ? [] : HAZARD_KINDS;
  if (target.base !== value) return HAZARD_KINDS;
  return target.constrained ? REWRITE : [];
}

function pairHazards(from: Type, to: Type): readonly HazardKind[] {
  if (from.name === "enum" || to.name === "enum") return enumRetypeHazards(from, to);
  return [
    ...(losesData(from, to) ? (["data_loss"] as const) : []),
    ...(rewrites(from, to) ? REWRITE : []),
  ];
}

/**
 * Any change to an array's element type rewrites, even `varchar(20)[]` to `varchar(40)[]`, and
 * keeps the element pair's other hazards. Scalar to array and back gets every hazard.
 */
function arrayRetypeHazards(
  from: string | undefined,
  to: string | undefined,
  named: NamedTypes,
): readonly HazardKind[] {
  if (from === undefined || to === undefined) return HAZARD_KINDS;
  const kept = new Set([...typeHazards(from, to, named), ...REWRITE]);
  return HAZARD_KINDS.filter((kind) => kept.has(kind));
}

/**
 * Text to an enum, an enum to text, and one enum to another rewrite. A row that fits no label
 * fails the statement, so it loses nothing. Any other pair with an enum gets every hazard.
 */
function enumRetypeHazards(from: Type, to: Type): readonly HazardKind[] {
  const known = (type: Type): boolean => type.name === "enum" || type.name === "text";
  return known(from) && known(to) ? REWRITE : HAZARD_KINDS;
}

/**
 * Only the pairs Postgres converts in place without touching the rows skip the rewrite. Every
 * other pair rewrites, including `timestamp` and `timestamptz`, which skip it only when the
 * migrating session's time zone is UTC.
 */
function rewrites(from: Type, to: Type): boolean {
  if (from.name === "character varying") return varcharRewrites(from, to);
  if (from.name === "text") return to.name !== "character varying" || to.length !== undefined;
  if (from.name === "numeric" && to.name === "numeric") return numericRewrites(from, to);
  return true;
}

function varcharRewrites(from: Varchar, to: Type): boolean {
  if (to.name === "text") return false;
  if (to.name !== "character varying") return true;
  return !(to.length === undefined || (from.length !== undefined && to.length >= from.length));
}

function numericRewrites(from: Numeric, to: Numeric): boolean {
  if (to.precision === undefined) return false;
  return !(
    from.precision !== undefined &&
    from.scale === to.scale &&
    to.precision >= from.precision
  );
}

const INTEGERS: ReadonlySet<string> = new Set(["smallint", "integer", "bigint"]);
const FLOATS: ReadonlySet<string> = new Set(["real", "double precision"]);
const TIMESTAMPS: ReadonlySet<string> = new Set([
  "timestamp without time zone",
  "timestamp with time zone",
]);

/**
 * True when Postgres converts a value without an error but not back to what it was: rounding,
 * truncation, or lost precision. A conversion that fails on a value that doesn't fit, such as
 * `bigint` to `integer` or `text` to `varchar(5)`, loses nothing, since the statement rolls back.
 */
function losesData(from: Type, to: Type): boolean {
  if (INTEGERS.has(from.name)) return integerLosesData(from.name, to);
  if (from.name === "numeric") return numericLosesData(from, to);
  if (FLOATS.has(from.name)) return floatLosesData(from.name, to);
  if (TIMESTAMPS.has(from.name)) return to.name === "date";
  return false;
}

function integerLosesData(from: Type["name"], to: Type): boolean {
  if (to.name === "real") return from !== "smallint";
  if (to.name === "double precision") return from === "bigint";
  return false;
}

function numericLosesData(from: Numeric, to: Type): boolean {
  const wholeNumbers = from.precision !== undefined && from.scale === 0;
  if (INTEGERS.has(to.name)) return !wholeNumbers;
  // Precision of a float: 6 decimal digits for real, 15 for double precision.
  if (to.name === "real") return holdsMoreDigitsThan(from, 6);
  if (to.name === "double precision") return holdsMoreDigitsThan(from, 15);
  if (to.name === "numeric") return numericNarrows(from, to);
  return false;
}

function holdsMoreDigitsThan(from: Numeric, digits: number): boolean {
  return from.precision === undefined || from.precision > digits;
}

function numericNarrows(from: Numeric, to: Numeric): boolean {
  if (to.precision === undefined) return false;
  return from.precision === undefined || to.scale < from.scale;
}

function floatLosesData(from: Type["name"], to: Type): boolean {
  if (INTEGERS.has(to.name) || to.name === "numeric") return true;
  return from === "double precision" && to.name === "real";
}
