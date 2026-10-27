import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { elementOf, parentOf, typeName, type Catalog, type Fact } from "../catalog/index.ts";

type EnumFact = Extract<Fact, { readonly kind: "enum" }>;

/** The types either catalog declares as enums, spelled the way a column's `type` is. */
export function enumTypes(...catalogs: readonly Catalog[]): ReadonlySet<string> {
  return new Set(
    catalogs.flatMap((catalog) =>
      [...catalog.values()].flatMap((fact) =>
        fact.kind === "enum" ? [typeName(parentOf(catalog, fact).name, fact.name)] : [],
      ),
    ),
  );
}

/**
 * The ` using` clause of a retype from `before` to `after`, or `""`. Postgres has no implicit cast
 * from text or an enum to an enum, nor between their arrays, but every enum reads and writes as
 * text, so the cast goes through it (ADR-0023). Any other pair needs no cast or a hand edit.
 */
export function enumRetypeUsing(
  column: string,
  before: string,
  after: string,
  enums: ReadonlySet<string>,
): string {
  if ((elementOf(before) === undefined) !== (elementOf(after) === undefined)) return "";
  const fromText = [...enums, "text"].includes(withoutArray(before));
  return fromText && enums.has(withoutArray(after))
    ? ` using ${quoteIdentifier(column)}::text::${after}`
    : "";
}

const withoutArray = (type: string): string => elementOf(type) ?? type;

/**
 * The position of `label` among the labels `to` declares. A label before the first one `from`
 * has goes `BEFORE` it, and any other goes `AFTER` the label declared just ahead, which exists by
 * then since the actions for one enum run in declared order. The first label of an enum with none
 * takes no position.
 */
export function labelPosition(after: EnumFact, before: EnumFact, label: string): string {
  const { labels } = after.payload;
  const previous = labels[labels.indexOf(label) - 1];
  if (previous !== undefined) return ` after ${quoteLiteral(previous)}`;
  const first = labels.find((existing) => before.payload.labels.includes(existing));
  return first === undefined ? "" : ` before ${quoteLiteral(first)}`;
}

export function quoteLiteral(label: string): string {
  return `'${label.replaceAll("'", "''")}'`;
}
