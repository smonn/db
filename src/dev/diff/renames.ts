import {
  arePayloadsEqual,
  factAt,
  type Catalog,
  type ColumnRename,
  type Fact,
  type Rename,
  type TableRename,
} from "../catalog/index.ts";
import type { Action } from "./actions.ts";
import { typeRenameAction } from "./type-renames.ts";

/** The names of the fact `from` holds for a rename, under the new name. */
function pathOf(rename: Rename): string[] {
  if (rename.kind === "column") return [rename.schema, rename.table, rename.name];
  if (rename.kind === "enum label") return [rename.schema, rename.enum];
  return [rename.schema, rename.name];
}

/** The action for one rename, on the fact `from` holds under the new name. */
export function renameAction(rename: Rename, from: Catalog): Action {
  const path = pathOf(rename);
  const fact = factAt(from, ...path);
  const action = fact === undefined ? undefined : actionFor(rename, fact);
  if (action === undefined) {
    throw new Error(`the renamed ${rename.kind} ${path.join(".")} isn't in the catalog`);
  }
  return action;
}

function actionFor(rename: Rename, fact: Fact): Action | undefined {
  return rename.kind === "table" || rename.kind === "column"
    ? tableRenameAction(rename, fact)
    : typeRenameAction(rename, fact);
}

function tableRenameAction(rename: TableRename | ColumnRename, fact: Fact): Action | undefined {
  if (rename.kind === "table" && fact.kind === "table") {
    return { kind: "rename table", fact, rename };
  }
  if (rename.kind === "column" && fact.kind === "column") {
    return { kind: "rename column", fact, rename };
  }
  return undefined;
}

type Check = Action<"drop domain check" | "add domain check">;

/**
 * Turns a dropped and an added check of one domain with the same expression into one
 * `RENAME CONSTRAINT`, with no Hazard (ADR-0024). Two candidates on either side are ambiguous, so
 * they stay a drop and an add.
 */
export function renameChecks(actions: readonly Action[]): Action[] {
  const drops = actions.filter((action) => action.kind === "drop domain check");
  const adds = actions.filter((action) => action.kind === "add domain check");
  const paired = new Set<Action>();
  const renames: Action[] = [];
  for (const add of adds) {
    const drop = soleMatch(drops, add);
    if (drop === undefined || soleMatch(adds, drop) === undefined) continue;
    paired.add(drop).add(add);
    renames.push({ kind: "rename domain check", fact: add.fact, was: drop.fact.name });
  }
  return [...actions.filter((action) => !paired.has(action)), ...renames];
}

/** The one of `candidates` that checks the same domain for the same expression as `check`. */
function soleMatch<A extends Check>(candidates: readonly A[], check: Check): A | undefined {
  const matches = candidates.filter(
    ({ fact }) =>
      fact.parent === check.fact.parent && arePayloadsEqual(fact.payload, check.fact.payload),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
