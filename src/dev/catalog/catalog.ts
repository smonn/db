import type { Table } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { postgresType } from "./column-type.ts";
import { constraintNames, type ConstraintNames } from "./constraint-names.ts";

export type ColumnPayload = {
  /** The type as `format_type` renders it, such as `character varying(20)`. */
  readonly type: string;
  /** True for a Postgres 18 `pg_constraint` NOT NULL row too, whatever its constraint name. */
  readonly notNull: boolean;
};

export type DefaultPayload = {
  /** The expression as `pg_get_expr` renders it, such as `now()` or `'new'::text`. */
  readonly expression: string;
  /**
   * True when the expression calls a volatile function, such as `random()` or `nextval`, so
   * adding the column evaluates it once per row instead of once for the table.
   */
  readonly volatile: boolean;
};

export type IdentityPayload = {
  readonly generated: "always" | "by default";
};

export type GeneratedPayload = {
  /** The expression as `pg_get_expr` renders it, such as `(a * 2)`. */
  readonly expression: string;
  /** Postgres 18 defaults to `virtual`; only `stored` keeps its values on disk. */
  readonly storage: "stored" | "virtual";
};

export type PrimaryKeyPayload = {
  /** In key order, which is the order the index sorts by. */
  readonly columns: readonly string[];
};

export type UniquePayload = {
  readonly column: string;
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
    }
  | {
      readonly kind: "default";
      readonly name: typeof DEFAULT_NAME;
      readonly parent: Key;
      readonly payload: DefaultPayload;
    }
  | {
      readonly kind: "identity";
      readonly name: typeof IDENTITY_NAME;
      readonly parent: Key;
      readonly payload: IdentityPayload;
    }
  | {
      readonly kind: "generated";
      readonly name: typeof GENERATED_NAME;
      readonly parent: Key;
      readonly payload: GeneratedPayload;
    }
  | {
      /** Named by its constraint, since a drop must say which one. */
      readonly kind: "primary key";
      readonly name: string;
      readonly parent: Key;
      readonly payload: PrimaryKeyPayload;
    }
  | {
      readonly kind: "unique";
      readonly name: string;
      readonly parent: Key;
      readonly payload: UniquePayload;
    };

/** A fact on a column, before the builder gives it its parent. */
type ColumnAttribute = Fact extends infer F
  ? F extends { readonly kind: "default" | "identity" | "generated" }
    ? Omit<F, "parent">
    : never
  : never;

/** A column has at most one default, identity, and generation expression, so their names are fixed. */
const DEFAULT_NAME = "default";
const IDENTITY_NAME = "identity";
const GENERATED_NAME = "generated";

/**
 * Every modeled object, keyed by the chain of names from its schema down. The payload leaves out
 * the name, so a rename can be detected later.
 */
export type Catalog = ReadonlyMap<Key, Fact>;

export type CatalogBuilder = {
  schema(name: string): void;
  table(schema: string, name: string): void;
  column(schema: string, table: string, name: string, payload: ColumnPayload): void;
  columnDefault(schema: string, table: string, column: string, payload: DefaultPayload): void;
  columnIdentity(schema: string, table: string, column: string, payload: IdentityPayload): void;
  columnGenerated(schema: string, table: string, column: string, payload: GeneratedPayload): void;
  primaryKey(schema: string, table: string, name: string, payload: PrimaryKeyPayload): void;
  unique(schema: string, table: string, name: string, payload: UniquePayload): void;
  build(): Catalog;
};

/** Throws when a fact names a parent, or a key names a column, not added yet. */
export function catalogBuilder(): CatalogBuilder {
  const catalog = new Map<Key, Fact>();
  const added = (kind: Fact["kind"], ...names: string[]): Key => {
    const existing = key(...names);
    if (!catalog.has(existing)) throw new Error(`${kind} ${quoted(names)} isn't in the catalog`);
    return existing;
  };
  const attribute = (schema: string, table: string, column: string, fact: ColumnAttribute) => {
    const parent = added("column", schema, table, column);
    catalog.set(key(schema, table, column, fact.name), { ...fact, parent });
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
    columnDefault(schema, table, column, payload) {
      attribute(schema, table, column, { kind: "default", name: DEFAULT_NAME, payload });
    },
    columnIdentity(schema, table, column, payload) {
      attribute(schema, table, column, { kind: "identity", name: IDENTITY_NAME, payload });
    },
    columnGenerated(schema, table, column, payload) {
      attribute(schema, table, column, { kind: "generated", name: GENERATED_NAME, payload });
    },
    primaryKey(schema, table, name, payload) {
      const parent = added("table", schema, table);
      for (const column of payload.columns) added("column", schema, table, column);
      catalog.set(constraintKey(parent, name), { kind: "primary key", name, parent, payload });
    },
    unique(schema, table, name, payload) {
      const parent = added("table", schema, table);
      added("column", schema, table, payload.column);
      catalog.set(constraintKey(parent, name), { kind: "unique", name, parent, payload });
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
    const names = constraintNames(schema, tables);
    for (const [table, definitionTable] of Object.entries(tables)) {
      addTable(builder, { schema, table, names }, definitionTable);
    }
  }
  return builder.build();
}

type TableContext = {
  readonly schema: string;
  readonly table: string;
  readonly names: ConstraintNames;
};

function addTable(
  builder: CatalogBuilder,
  { schema, table, names }: TableContext,
  { columns, primaryKey, primaryKeyName }: Table,
): void {
  builder.table(schema, table);
  const entries = Object.entries(columns);
  for (const [column, { state }] of entries) {
    builder.column(schema, table, column, {
      type: postgresType(state.sqlType),
      notNull: state.notNull || primaryKey.includes(column) || state.identity !== undefined,
    });
    // introspect reads the real volatility from the Definition database.
    if (state.default !== undefined) {
      builder.columnDefault(schema, table, column, { expression: state.default, volatile: false });
    }
    if (state.identity !== undefined) {
      builder.columnIdentity(schema, table, column, { generated: state.identity });
    }
  }
  if (primaryKey.length > 0) {
    builder.primaryKey(schema, table, names.primaryKey(table, primaryKey, primaryKeyName), {
      columns: [...primaryKey],
    });
  }
  for (const [column, { state }] of entries) {
    if (state.unique) {
      const name = names.unique(table, column, state.constraintName);
      builder.unique(schema, table, name, { column });
    }
  }
}

// No Postgres name can hold a NUL byte, so no two chains of names join to the same key.
const SEPARATOR = "\0";

function key(...names: string[]): Key {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brand exists only in types.
  return names.join(SEPARATOR) as Key;
}

/**
 * An empty segment can't be a Postgres name, so a constraint never keys like a column of the
 * same name on its table.
 */
function constraintKey(table: Key, name: string): Key {
  return key(table, "", name);
}

function keyOf(fact: Fact): Key {
  if (fact.parent === undefined) return key(fact.name);
  return fact.kind === "primary key" || fact.kind === "unique"
    ? constraintKey(fact.parent, fact.name)
    : key(fact.parent, fact.name);
}

function quoted(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
