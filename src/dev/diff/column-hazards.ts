import { childrenOf, childrenOfKind, type Catalog, type Key } from "../catalog/index.ts";
import { domainTypes, type DeclaredDomain } from "./domains.ts";
import { enumRetypeUsing, enumTypes } from "./enums.ts";
import { storageOf } from "./generation.ts";
import { retypeHazards, type HazardKind } from "./hazards.ts";
import type { FactOf } from "./statements.ts";

/** The hazards of retyping `before` to `after`, a column as `from` and as `to` have it. */
export function columnRetypeHazards(
  before: FactOf<"column">,
  after: FactOf<"column">,
  { from, to }: { readonly from: Catalog; readonly to: Catalog },
): readonly HazardKind[] {
  return retypeHazards(
    before.payload.type,
    after.payload.type,
    enumTypes(from, to),
    domainTypes(from, to),
  );
}

/** Whether `from` has the table at `key`, not a type that a table of its name replaces. */
export function holdsRows(from: Catalog, key: Key): boolean {
  return from.get(key)?.kind === "table";
}

/** The `type` clause of retyping `before` to `after`, with the `using` an enum needs. */
export function retypeClause(
  before: FactOf<"column">,
  after: FactOf<"column">,
  { from, to }: { readonly from: Catalog; readonly to: Catalog },
): string {
  const { type } = after.payload;
  const using = enumRetypeUsing(after.name, before.payload.type, type, enumTypes(from, to));
  return `type ${type}${using}`;
}

/**
 * Whether adding `column` writes every row: an identity fills each from its sequence, as a
 * volatile default does, its own or its domain's, a stored expression computes each, and a
 * constrained domain checks each.
 */
export function fillsEachRow(column: FactOf<"column">, to: Catalog): boolean {
  const children = childrenOf(to, column);
  const domain = domainTypes(to).get(column.payload.type);
  if (domain !== undefined && domainFillsEachRow(domain, children.length === 0)) return true;
  return (
    childrenOfKind(to, column, "identity").length > 0 ||
    childrenOfKind(to, column, "default").some((fact) => fact.payload.volatile) ||
    storageOf(to, column) === "stored"
  );
}

/** A column with no default, identity, or expression of its own takes its domain's default. */
function domainFillsEachRow(domain: DeclaredDomain, takesDomainDefault: boolean): boolean {
  return domain.constrained || (takesDomainDefault && domain.volatileDefault);
}
