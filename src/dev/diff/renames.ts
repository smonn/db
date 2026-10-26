import { factAt, type Catalog, type Fact, type Rename } from "../catalog/index.ts";
import type { Action } from "./actions.ts";

/** The action for one rename, on the fact `from` holds under the new name. */
export function renameAction(rename: Rename, from: Catalog): Action {
  const names = namesOfRename(rename);
  const fact = factAt(from, ...names);
  const action = fact === undefined ? undefined : actionFor(rename, fact);
  if (action === undefined) {
    throw new Error(`the renamed ${rename.kind} ${names.join(".")} isn't in the catalog`);
  }
  return action;
}

function actionFor(rename: Rename, fact: Fact): Action | undefined {
  if (rename.kind === "table" && fact.kind === "table") {
    return { kind: "rename table", fact, rename };
  }
  if (rename.kind === "column" && fact.kind === "column") {
    return { kind: "rename column", fact, rename };
  }
  return undefined;
}

function namesOfRename(rename: Rename): string[] {
  if (rename.kind === "table") return [rename.schema, rename.name];
  return [rename.schema, rename.table, rename.name];
}
