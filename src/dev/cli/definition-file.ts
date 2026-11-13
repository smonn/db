import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { DefinitionTables } from "../catalog/index.ts";

/** Refuses `value`, the default export of the Definition file at `file`, unless it's a Definition. */
export function definitionOf(file: string, value: unknown): DefinitionTables {
  if (!isDefinition(value)) {
    throw new Error(
      `${relative(process.cwd(), file)} must export defineDatabase({ ... }) as its default export`,
    );
  }
  return value;
}

function isDefinition(value: unknown): value is DefinitionTables {
  return typeof value === "object" && value !== null;
}

export function importDefault(file: string): Promise<unknown> {
  return import(pathToFileURL(file).href).then(
    (module: { readonly default?: unknown }) => module.default,
  );
}
