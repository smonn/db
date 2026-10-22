import type { Table } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";

export type ColumnPayload = {
  readonly type: string;
  readonly notNull: boolean;
};

/** Schemas and tables carry nothing beyond their name in v0.1. */
type NoPayload = Readonly<Record<string, never>>;

/** Type-only: only this module builds keys, so every producer keys a chain of names the same way. */
export type Key = string & { readonly "~key": true };

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
      readonly parent: Key;
      readonly payload: NoPayload;
    }
  | {
      readonly kind: "column";
      readonly name: string;
      readonly parent: Key;
      readonly payload: ColumnPayload;
    };

/**
 * Every modeled object, keyed by the chain of names from its schema down. The payload leaves out
 * the name, so a rename can be detected later.
 */
export type Catalog = ReadonlyMap<Key, Fact>;

export type CatalogBuilder = {
  schema(name: string): void;
  table(schema: string, name: string): void;
  column(schema: string, table: string, name: string, payload: ColumnPayload): void;
  build(): Catalog;
};

/** Throws when a table or column names a parent not added yet. */
export function catalogBuilder(): CatalogBuilder {
  const catalog = new Map<Key, Fact>();
  const added = (kind: Fact["kind"], ...names: string[]): Key => {
    const existing = key(...names);
    if (!catalog.has(existing)) throw new Error(`${kind} ${quoted(names)} isn't in the catalog`);
    return existing;
  };
  return {
    schema(name) {
      catalog.set(key(name), { kind: "schema", name, parent: undefined, payload: {} });
    },
    table(schema, name) {
      const parent = added("schema", schema);
      catalog.set(key(schema, name), { kind: "table", name, parent, payload: {} });
    },
    column(schema, table, name, payload) {
      const parent = added("table", schema, table);
      catalog.set(key(schema, table, name), { kind: "column", name, parent, payload });
    },
    build: () => new Map(catalog),
  };
}

export function parentOf(catalog: Catalog, fact: Fact): Fact {
  const parent = fact.parent === undefined ? undefined : catalog.get(fact.parent);
  if (parent === undefined)
    throw new Error(`${fact.kind} ${quoted([fact.name])} has no parent in the catalog`);
  return parent;
}

/** Keeps catalog order, which sets the column order of a created table. */
export function childrenOf(catalog: Catalog, fact: Fact): readonly Fact[] {
  const parent = keyOf(fact);
  return [...catalog.values()].filter((child) => child.parent === parent);
}

export function namesOf(catalog: Catalog, fact: Fact): readonly string[] {
  return fact.parent === undefined
    ? [fact.name]
    : [...namesOf(catalog, parentOf(catalog, fact)), fact.name];
}

/** The shape `defineDatabase` returns, loosened so any Definition fits. */
export type DefinitionTables = {
  readonly [schema: string]: { readonly [table: string]: Table };
};

export function definitionCatalog(definition: DefinitionTables): Catalog {
  const builder = catalogBuilder();
  for (const [schema, tables] of Object.entries(definition)) {
    builder.schema(schema);
    for (const [table, { columns }] of Object.entries(tables)) {
      builder.table(schema, table);
      for (const [column, { state }] of Object.entries(columns)) {
        builder.column(schema, table, column, { type: state.sqlType, notNull: state.notNull });
      }
    }
  }
  return builder.build();
}

// No Postgres name can hold a NUL byte, so no two chains of names join to the same key.
const SEPARATOR = "\0";

function key(...names: string[]): Key {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brand exists only in types.
  return names.join(SEPARATOR) as Key;
}

function keyOf(fact: Fact): Key {
  return fact.parent === undefined ? key(fact.name) : key(fact.parent, fact.name);
}

function quoted(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
