import {
  definitionCatalog,
  definitionSchemas,
  type DefinitionTables,
} from "./definition-catalog.ts";
import type { Catalog } from "./fact.ts";
import type { Rename } from "./rename-types.ts";
import { declaredRenames } from "./renames.ts";

/**
 * All that generate reads from a Definition, as plain data. A Definition holds closures, so a Worker
 * can post this and not the Definition itself.
 */
export type CatalogDefinition = {
  readonly catalog: Catalog;
  /** The SQL names of the Definition's schemas. */
  readonly schemas: readonly string[];
  /** Its `renamedFrom` markers, in the order the renames run. */
  readonly renames: readonly Rename[];
};

export function readDefinition(database: DefinitionTables): CatalogDefinition {
  return {
    catalog: definitionCatalog(database),
    schemas: definitionSchemas(database),
    renames: declaredRenames(database),
  };
}
