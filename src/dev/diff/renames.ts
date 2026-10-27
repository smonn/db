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
  if (rename.kind === "table") {
    return fact.kind === "table" ? { kind: "rename table", fact, rename } : undefined;
  }
  return fact.kind === "column" ? { kind: "rename column", fact, rename } : undefined;
}

type Added = Action<
  "add domain check" | "add primary key" | "add unique" | "add foreign key" | "add index"
>;

/** Each kind of dropped fact, with the kind of added fact it can be a rename of. */
const PAIRS: readonly (readonly [drop: Action["kind"], add: Added["kind"]])[] = [
  ["drop domain check", "add domain check"],
  ["drop primary key", "add primary key"],
  ["drop unique", "add unique"],
  ["drop foreign key", "add foreign key"],
  ["drop index", "add index"],
];

function renameOf(add: Added, was: string): Action {
  if (add.kind === "add domain check") return { kind: "rename domain check", fact: add.fact, was };
  if (add.kind === "add index") return { kind: "rename index", fact: add.fact, was };
  return { kind: "rename constraint", fact: add.fact, was };
}

/**
 * Turns a dropped and an added check, key, or index of one parent with the same payload into one
 * rename, with no Hazard (ADR-0024). Two candidates on either side are ambiguous, so they stay a
 * drop and an add.
 */
export function renameByPayload(actions: readonly Action[]): Action[] {
  const paired = new Set<Action>();
  const renames: Action[] = [];
  for (const [dropKind, addKind] of PAIRS) {
    const drops = actions.filter((action) => action.kind === dropKind);
    const adds = actions.filter((action): action is Added => action.kind === addKind);
    for (const add of adds) {
      const drop = soleMatch(drops, add);
      if (drop === undefined || soleMatch(adds, drop) === undefined) continue;
      // The name stays taken until the drop, which runs after the renames: a fact of that name
      // changed, or the add is a rebuild of it.
      if (
        drops.some(({ fact }) => fact.parent === add.fact.parent && fact.name === add.fact.name)
      ) {
        continue;
      }
      paired.add(drop).add(add);
      renames.push(renameOf(add, drop.fact.name));
    }
  }
  return [...actions.filter((action) => !paired.has(action)), ...renames];
}

/** The one of `candidates` under the same parent as `other`, with the same payload. */
function soleMatch(candidates: readonly Action[], other: Action): Action | undefined {
  const matches = candidates.filter(
    ({ fact }) =>
      fact.parent === other.fact.parent && arePayloadsEqual(fact.payload, other.fact.payload),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
