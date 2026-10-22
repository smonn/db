import type { Table } from "../../runtime/definition/index.ts";

export type ColumnPayload = {
  readonly type: string;
  readonly notNull: boolean;
};

/** Schemas and tables carry nothing beyond their name in v0.1. */
type NoPayload = Readonly<Record<string, never>>;

export type Fact =
  | {
      readonly kind: "schema";
      readonly name: string;
      readonly parent: undefined;
      readonly payload: NoPayload;
    }
  | {
      readonly kind: "table";
      readonly name: string;
      readonly parent: string;
      readonly payload: NoPayload;
    }
  | {
      readonly kind: "column";
      readonly name: string;
      readonly parent: string;
      readonly payload: ColumnPayload;
    };

/**
 * Every modeled object, keyed by the dotted chain of names from its schema down, such as
 * `public.users.email`. The payload leaves out the name, so a rename can be detected later.
 */
export type Catalog = ReadonlyMap<string, Fact>;

/** The shape `defineDatabase` returns, loosened so any Definition fits. */
export type DefinitionTables = {
  readonly [schema: string]: { readonly [table: string]: Table };
};

export function definitionCatalog(definition: DefinitionTables): Catalog {
  const catalog = new Map<string, Fact>();
  for (const [schema, tables] of Object.entries(definition)) {
    catalog.set(schema, { kind: "schema", name: schema, parent: undefined, payload: {} });
    for (const [table, { columns }] of Object.entries(tables)) {
      const tablePath = `${schema}.${table}`;
      catalog.set(tablePath, { kind: "table", name: table, parent: schema, payload: {} });
      for (const [column, { state }] of Object.entries(columns)) {
        catalog.set(`${tablePath}.${column}`, {
          kind: "column",
          name: column,
          parent: tablePath,
          payload: { type: state.sqlType, notNull: state.notNull },
        });
      }
    }
  }
  return catalog;
}
