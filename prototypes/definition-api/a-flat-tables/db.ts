// PROTOTYPE, throwaway. Variant A stands in for `@smonn/db`: every table is
// its own export, and the CLI collects the exported tables from each
// Definition file.

import { isTable, makeTable, type Columns, type Table, type TableOptions } from "../core.ts";

export * from "../core.ts";

export function table<C extends Columns>(name: string, columns: C, options?: TableOptions<NoInfer<C>>): Table<C> {
  return makeTable("public", name, columns, options);
}

export function schema(schemaName: string) {
  return {
    table: <C extends Columns>(name: string, columns: C, options?: TableOptions<NoInfer<C>>): Table<C> =>
      makeTable(schemaName, name, columns, options),
  };
}

// What the CLI does with each loaded Definition module.
export function collectTables(module: Record<string, unknown>): Table[] {
  return Object.values(module).filter(isTable);
}
