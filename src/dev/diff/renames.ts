import { factAt, type Catalog, type Rename } from "../catalog/index.ts";
import type { Action } from "./actions.ts";

/** The action for one rename, on the fact `from` holds under the new name. */
export function renameAction(rename: Rename, from: Catalog): Action {
  const names =
    rename.kind === "table"
      ? [rename.schema, rename.name]
      : [rename.schema, rename.table, rename.name];
  const fact = factAt(from, ...names);
  if (rename.kind === "table" && fact?.kind === "table") {
    return { kind: "rename table", fact, rename };
  }
  if (rename.kind === "column" && fact?.kind === "column") {
    return { kind: "rename column", fact, rename };
  }
  throw new Error(`the renamed ${rename.kind} ${names.join(".")} isn't in the catalog`);
}
