import {
  parentOf,
  plainKeyColumns,
  type Catalog,
  type Fact,
  type IndexPayload,
  type Key,
  unchangedFacts,
} from "../catalog/index.ts";
import type { Action, Catalogs } from "./actions.ts";
import { swapOf } from "./enum-swap.ts";
import { storageOf } from "./generation.ts";

/**
 * The columns `ALTER COLUMN` can't convert: Postgres can't make a plain column generated, switch
 * a column between stored and virtual, or drop the expression of a virtual one.
 */
export function rebuiltColumns({ from, to }: Catalogs): ReadonlyMap<Key, Fact> {
  const rebuilt = new Map<Key, Fact>();
  for (const [key, before] of from) {
    const after = to.get(key);
    // A column's key is no other kind's, so `before` is a column too.
    if (after?.kind !== "column") continue;
    if (needsRebuild({ from, to }, before, after)) rebuilt.set(key, after);
  }
  return rebuilt;
}

function needsRebuild({ from, to }: Catalogs, before: Fact, after: Fact): boolean {
  const was = storageOf(from, before);
  const now = storageOf(to, after);
  if (was === now) return false;
  return !(now === undefined && was === "stored");
}

/** Whether the column changes type, or keeps the name of an enum that swaps (ADR-0023). */
export function retyped(column: Key, catalogs: Catalogs): boolean {
  const before = catalogs.from.get(column);
  const after = catalogs.to.get(column);
  return (
    before?.kind === "column" &&
    after?.kind === "column" &&
    (before.payload.type !== after.payload.type ||
      swapOf(after.payload.type, catalogs) !== undefined)
  );
}

/**
 * `catalog` without the rebuilt columns, the facts under them, and the facts that name them, which
 * `columnsNamed` reads off each fact.
 */
export function without(
  catalog: Catalog,
  rebuilt: ReadonlyMap<Key, Fact>,
  columnsNamed: (fact: Fact) => readonly string[],
): Catalog {
  const columns = [...rebuilt.values()];
  const rebuiltKeys: ReadonlySet<Key | undefined> = new Set(rebuilt.keys());
  return new Map(
    [...catalog].filter(
      ([key, fact]) =>
        !rebuiltKeys.has(key) &&
        !rebuiltKeys.has(fact.parent) &&
        !columns.some(
          (column) => column.parent === fact.parent && columnsNamed(fact).includes(column.name),
        ),
    ),
  );
}

type ForeignKey = Extract<Fact, { readonly kind: "foreign key" }>;

/**
 * `planned` with each foreign key that stays as it is, or only changes its name, rebuilt around a
 * target key or column that is dropped, rebuilt, or retyped, since Postgres refuses those changes
 * under it (#381). A blocked rename gives way to a drop of the old name and an add of the new one.
 * `planned` already drops a foreign key that changes itself or names a rebuilt column.
 */
export function foreignKeysAround(planned: readonly Action[], catalogs: Catalogs): Action[] {
  const changed = changedColumns(planned);
  const blocked = (key: ForeignKey): boolean => isBlocked(key, planned, changed, catalogs.from);
  const renames = blockedRenames(planned, blocked);
  const unchanged = unchangedFacts(catalogs.from, catalogs.to, "foreign key")
    .filter(([key]) => !dropsForeignKey(planned, key) && blocked(key))
    .flatMap(([before, after]) => rebuild(before, after));
  return [
    ...planned.filter((action) => !renames.has(action)),
    ...[...renames.values()].flat(),
    ...unchanged,
  ];
}

function rebuild(before: ForeignKey, after: ForeignKey): Action[] {
  return [
    { kind: "drop foreign key", fact: before },
    { kind: "add foreign key", fact: after },
  ];
}

/**
 * The rebuild that replaces each rename of a foreign key that `blocked` holds up. A rename pairs
 * keys of one payload, so the old key is the new one under its old name.
 */
function blockedRenames(
  planned: readonly Action[],
  blocked: (key: ForeignKey) => boolean,
): Map<Action, Action[]> {
  const rebuilds = new Map<Action, Action[]>();
  for (const action of planned) {
    if (action.kind !== "rename constraint" || action.fact.kind !== "foreign key") continue;
    if (blocked(action.fact)) {
      rebuilds.set(action, rebuild({ ...action.fact, name: action.was }, action.fact));
    }
  }
  return rebuilds;
}

function dropsForeignKey(planned: readonly Action[], foreignKey: ForeignKey): boolean {
  return planned.some(
    ({ kind, fact }) =>
      kind === "drop foreign key" &&
      fact.parent === foreignKey.parent &&
      fact.name === foreignKey.name,
  );
}

function isBlocked(
  { parent, payload }: ForeignKey,
  planned: readonly Action[],
  changed: ReadonlySet<string>,
  from: Catalog,
): boolean {
  const targets = tableKeysAt(from, payload.target.schema, payload.target.table);
  return (
    payload.columns.some((column) => changed.has(columnId(parent, column))) ||
    targets.some(
      (target) =>
        payload.target.columns.some((column) => changed.has(columnId(target, column))) ||
        dropsKeyOn(planned, target, payload.target.columns),
    )
  );
}

/** The columns an action retypes in a way that breaks a foreign key on them. */
function changedColumns(planned: readonly Action[]): ReadonlySet<string> {
  const changed = new Set<string>();
  for (const action of planned) {
    if (
      action.kind === "swap retype" ||
      (action.kind === "alter type" &&
        !keepsForeignKey(action.before.payload.type, action.fact.payload.type))
    ) {
      changed.add(columnId(action.fact.parent, action.fact.name));
    }
  }
  return changed;
}

function columnId(table: Key, column: string): string {
  return `${table}\0${column}`;
}

/** The key of the table `schema.table`: none when the catalog lacks it. */
function tableKeysAt(catalog: Catalog, schema: string, table: string): Key[] {
  return [...catalog]
    .filter(
      ([, fact]) =>
        fact.kind === "table" && fact.name === table && parentOf(catalog, fact).name === schema,
    )
    .map(([key]) => key);
}

/** Whether `planned` drops a key of `table` that a foreign key to `columns` could stand on. */
function dropsKeyOn(planned: readonly Action[], table: Key, columns: readonly string[]): boolean {
  return planned.some((action) => {
    const key = action.fact.parent === table ? droppedKeyColumns(action) : undefined;
    return (
      key !== undefined &&
      key.length === columns.length &&
      key.every((column) => columns.includes(column))
    );
  });
}

/** The columns of a key an action drops, if a foreign key could stand on it. */
function droppedKeyColumns(action: Action): readonly string[] | undefined {
  if (action.kind === "drop primary key" || action.kind === "drop unique") {
    return action.fact.payload.columns;
  }
  return action.kind === "drop index" ? uniqueIndexColumns(action.fact.payload) : undefined;
}

/** The columns of an index a foreign key can stand on: unique, whole, and over plain columns. */
function uniqueIndexColumns({ unique, keys, where }: IndexPayload): readonly string[] | undefined {
  const plain = plainKeyColumns(keys);
  return unique && where === undefined && plain.length === keys.length ? plain : undefined;
}

/**
 * Types Postgres compares across, so a retype within one leaves a foreign key in place: the
 * integers, and text with varchar. Any other type is its own, whatever its modifiers.
 */
const FAMILIES: readonly (readonly string[])[] = [
  ["smallint", "integer", "bigint"],
  ["text", "character varying"],
];

function keepsForeignKey(before: string, after: string): boolean {
  return familyOf(before) === familyOf(after);
}

function familyOf(type: string): string {
  const base = type.replace(/\(.*\)$/u, "");
  return FAMILIES.find((family) => family.includes(base))?.[0] ?? base;
}
