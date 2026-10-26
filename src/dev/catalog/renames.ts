import { isDomain, isEnum, sqlDefinition } from "../../runtime/definition/index.ts";
import type { Catalog } from "./fact.ts";
import type { DefinitionTables } from "./definition-catalog.ts";
import { applies } from "./rename-applies.ts";
import type { Rename } from "./rename-types.ts";
import { appliedTypeRenames, declaredTypeRenames } from "./type-renames.ts";

export type { Rename } from "./rename-types.ts";

/**
 * Every `renamedFrom` marker in the Definition, in the order the renames run: tables, columns,
 * then enums, their labels, and domains.
 */
export function declaredRenames(database: DefinitionTables): Rename[] {
  const definition = sqlDefinition(database);
  const tables: Rename[] = [];
  const columns: Rename[] = [];
  for (const [schema, schemaTables] of Object.entries(definition)) {
    for (const [table, def] of Object.entries(schemaTables)) {
      if (isEnum(def) || isDomain(def)) continue;
      if (def.renamedFrom !== undefined) {
        tables.push({ kind: "table", schema, name: table, was: def.renamedFrom });
      }
      columns.push(...columnRenames(schema, table, def.columns));
    }
  }
  const { enums, labels, domains } = declaredTypeRenames(definition);
  return [...tables, ...columns, ...enums, ...labels, ...domains];
}

function columnRenames(
  schema: string,
  table: string,
  columns: Extract<DefinitionTables[string][string], { columns: unknown }>["columns"],
): Rename[] {
  const renames: Rename[] = [];
  for (const [name, { state }] of Object.entries(columns)) {
    if (state.renamedFrom === undefined) continue;
    renames.push({ kind: "column", schema, table, name, was: state.renamedFrom });
  }
  return renames;
}

/**
 * The declared renames to run against `shadow`, in the order `declaredRenames` lists (ADR-0024). A
 * marker whose old name isn't in the Shadow is skipped, since it is stale or its object is new.
 * Throws when the old and new names both exist, since Postgres would refuse the `RENAME` and
 * neither side is the safe one.
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
  const types = appliedTypeRenames(
    {
      enums: declared.filter((rename) => rename.kind === "enum"),
      labels: declared.filter((rename) => rename.kind === "enum label"),
      domains: declared.filter((rename) => rename.kind === "domain"),
    },
    shadow,
  );
  return [...applied, ...inShadow, ...types.enums, ...types.labels, ...types.domains];
}
