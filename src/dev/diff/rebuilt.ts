import {
  childrenOf,
  plainKeyColumns,
  type Catalog,
  type Fact,
  type GeneratedPayload,
  type IndexPayload,
  type Key,
} from "../catalog/index.ts";
import type { Action, Catalogs } from "./actions.ts";
import { swapOf } from "./enum-swap.ts";

/**
 * The columns `ALTER COLUMN` can't convert: Postgres can't make a plain column generated, switch
 * a column between stored and virtual, or drop the expression of a virtual one.
 */
export function rebuiltColumns({ from, to }: Catalogs): ReadonlyMap<Key, Fact> {
  const rebuilt = new Map<Key, Fact>();
  for (const [key, before] of from) {
    const after = to.get(key);
    if (before.kind !== "column" || after?.kind !== "column") continue;
    if (needsRebuild({ from, to }, before, after)) rebuilt.set(key, after);
  }
  return rebuilt;
}

function needsRebuild({ from, to }: Catalogs, before: Fact, after: Fact): boolean {
  const was = generation(from, before);
  const now = generation(to, after);
  if (was?.storage === now?.storage) return false;
  return !(now === undefined && was?.storage === "stored");
}

function generation(catalog: Catalog, column: Fact): GeneratedPayload | undefined {
  const child = childrenOf(catalog, column).find((fact) => fact.kind === "generated");
  return child?.kind === "generated" ? child.payload : undefined;
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
  return new Map(
    [...catalog].filter(
      ([key, fact]) =>
        !rebuilt.has(key) &&
        !(fact.parent !== undefined && rebuilt.has(fact.parent)) &&
        !columns.some(
          (column) => column.parent === fact.parent && columnsNamed(fact).includes(column.name),
        ),
    ),
  );
}

type ForeignKey = Extract<Fact, { readonly kind: "foreign key" }>;

/**
 * The drop and re-add of each foreign key that stays as it is while its target key or one of its
 * columns is dropped, rebuilt, or retyped, since Postgres refuses those changes under it (#381).
 * `planned` holds the other actions, which already drop a foreign key that changes itself or names
 * a rebuilt column.
 */
export function foreignKeysAround(planned: readonly Action[], catalogs: Catalogs): Action[] {
  const changed = changedColumns(planned);
  return unchangedForeignKeys(catalogs)
    .filter(
      ([key]) => !dropsForeignKey(planned, key) && isBlocked(key, planned, changed, catalogs.from),
    )
    .flatMap(([before, after]) => [
      { kind: "drop foreign key", fact: before },
      { kind: "add foreign key", fact: after },
    ]);
}

/** Each foreign key both catalogs hold under one name, as `from` and as `to` have it. */
function unchangedForeignKeys({ from, to }: Catalogs): [before: ForeignKey, after: ForeignKey][] {
  const pairs: [ForeignKey, ForeignKey][] = [];
  for (const [key, before] of from) {
    const after = to.get(key);
    if (before.kind === "foreign key" && after?.kind === "foreign key") pairs.push([before, after]);
  }
  return pairs;
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
  const target = tableKeyAt(from, payload.target.schema, payload.target.table);
  return (
    payload.columns.some((column) => changed.has(columnId(parent, column))) ||
    (target !== undefined &&
      (payload.target.columns.some((column) => changed.has(columnId(target, column))) ||
        dropsKeyOn(planned, target, payload.target.columns)))
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

function tableKeyAt(catalog: Catalog, schema: string, table: string): Key | undefined {
  return [...catalog].find(
    ([, fact]) =>
      fact.kind === "table" && fact.name === table && catalog.get(fact.parent)?.name === schema,
  )?.[0];
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
