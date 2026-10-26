import { isDomain, isEnum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { factAt } from "./catalog.ts";
import type { Catalog } from "./fact.ts";
import type { DefinitionTables } from "./definition-catalog.ts";

/** A table the Definition renames: `name` is its SQL name now, `was` the name it had. */
export type TableRename = {
  readonly kind: "table";
  readonly schema: string;
  readonly name: string;
  readonly was: string;
};

export type ColumnRename = {
  readonly kind: "column";
  readonly schema: string;
  /** The table's SQL name after the table renames, if it does. */
  readonly table: string;
  readonly name: string;
  readonly was: string;
};

export type Rename = TableRename | ColumnRename;

/** Every `renamedFrom` marker in the Definition, tables first. */
export function declaredRenames(definition: DefinitionTables): Rename[] {
  const tables: Rename[] = [];
  const columns: Rename[] = [];
  for (const [schema, schemaTables] of Object.entries(definition)) {
    for (const [table, def] of Object.entries(schemaTables)) {
      if (isEnum(def) || isDomain(def)) continue;
      if (def.renamedFrom !== undefined) {
        tables.push({ kind: "table", schema, name: table, was: def.renamedFrom });
      }
      for (const [name, { state }] of Object.entries(def.columns)) {
        if (state.renamedFrom === undefined) continue;
        columns.push({ kind: "column", schema, table, name, was: state.renamedFrom });
      }
    }
  }
  return [...tables, ...columns];
}

/**
 * The declared renames to run against `shadow`, tables first (ADR-0024). A marker whose old name
 * isn't in the Shadow is skipped, since it is stale or its object is new. Throws when the old and
 * new names both exist, since Postgres would refuse the `RENAME` and neither side is the safe one.
 */
export function appliedRenames(declared: readonly Rename[], shadow: Catalog): Rename[] {
  const tables = declared.filter((rename) => rename.kind === "table");
  const columns = declared.filter((rename) => rename.kind === "column");
  const applied: Rename[] = tables.filter((rename) =>
    applies(shadow, "table", [rename.schema, rename.name], rename.was),
  );
  // A column sits under the table's old name until the table's own `RENAME` runs.
  const was = new Map(applied.map((rename) => [`${rename.schema}\0${rename.name}`, rename.was]));
  const inShadow = columns.filter((rename) => {
    const table = was.get(`${rename.schema}\0${rename.table}`) ?? rename.table;
    return applies(shadow, "column", [rename.schema, table, rename.name], rename.was);
  });
  return [...applied, ...inShadow];
}

/** `path` is the new name's chain as the Shadow would hold it, and `was` replaces its last name. */
function applies(shadow: Catalog, kind: Rename["kind"], path: string[], was: string): boolean {
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
