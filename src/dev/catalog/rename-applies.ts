import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { factAt } from "./catalog.ts";
import type { Catalog, Fact } from "./fact.ts";

/**
 * Whether a rename of the `kind` fact at `path` (the new name's chain) applies to `shadow`, whose
 * fact still has the name `was` in place of the last one. Throws when both names exist, since
 * Postgres would refuse the `RENAME` and neither side is the safe one (ADR-0024).
 */
export function applies(shadow: Catalog, kind: Fact["kind"], path: string[], was: string): boolean {
  const hasOld = factAt(shadow, ...path.slice(0, -1), was)?.kind === kind;
  if (hasOld && factAt(shadow, ...path)?.kind === kind) {
    const quoted = path.map((part) => quoteIdentifier(part)).join(".");
    throw new Error(
      `${kind} ${quoted} has renamedFrom ${JSON.stringify(was)}, but the Shadow database holds both; ` +
        "drop the object you no longer want, or remove the marker",
    );
  }
  return hasOld;
}
