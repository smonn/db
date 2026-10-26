import { childrenOf, type Catalog } from "../catalog/index.ts";
import { domainTypes } from "./domains.ts";
import { enumTypes } from "./enums.ts";
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

/**
 * Whether adding `column` writes every row: an identity fills each from its sequence, as a
 * volatile default does, a stored expression computes each, and a constrained domain checks each.
 */
export function fillsEachRow(column: FactOf<"column">, to: Catalog): boolean {
  return (
    domainTypes(to).get(column.payload.type)?.constrained === true ||
    childrenOf(to, column).some(
      (child) =>
        child.kind === "identity" ||
        (child.kind === "default" && child.payload.volatile) ||
        (child.kind === "generated" && child.payload.storage === "stored"),
    )
  );
}
