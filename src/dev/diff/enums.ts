import { parentOf, typeName, type Catalog, type Fact } from "../catalog/index.ts";

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
