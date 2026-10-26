import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type {
  ColumnPayload,
  DefaultPayload,
  EnumPayload,
  ForeignKeyPayload,
  GeneratedPayload,
  IdentityPayload,
  PrimaryKeyPayload,
  UniquePayload,
} from "./payloads.ts";

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
      readonly kind: "enum";
      readonly name: string;
      readonly parent: Key;
      readonly payload: EnumPayload;
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
    }
  | {
      /** Named by its constraint; the payload names its target by schema, table, and columns. */
      readonly kind: "foreign key";
      readonly name: string;
      readonly parent: Key;
      readonly payload: ForeignKeyPayload;
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
  enumType(schema: string, name: string, payload: EnumPayload): void;
  column(schema: string, table: string, name: string, payload: ColumnPayload): void;
  columnDefault(schema: string, table: string, column: string, payload: DefaultPayload): void;
  columnIdentity(schema: string, table: string, column: string, payload: IdentityPayload): void;
  columnGenerated(schema: string, table: string, column: string, payload: GeneratedPayload): void;
  primaryKey(schema: string, table: string, name: string, payload: PrimaryKeyPayload): void;
  unique(schema: string, table: string, name: string, payload: UniquePayload): void;
  foreignKey(schema: string, table: string, name: string, payload: ForeignKeyPayload): void;
  build(): Catalog;
};

/**
 * Throws when a fact names a parent, or a key names a column, not added yet. A foreign key's
 * target may be added after it, so `build` checks the target.
 */
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
    enumType(schema, name, payload) {
      const parent = added("schema", schema);
      catalog.set(key(schema, name), { kind: "enum", name, parent, payload });
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
    ...constraintMethods(catalog, added),
    build() {
      for (const fact of catalog.values()) {
        if (fact.kind === "foreign key") requireTarget(fact.payload.target, added);
      }
      return new Map(catalog);
    },
  };
}

type Added = (kind: Fact["kind"], ...names: string[]) => Key;

function constraintMethods(
  catalog: Map<Key, Fact>,
  added: Added,
): Pick<CatalogBuilder, "primaryKey" | "unique" | "foreignKey"> {
  const add = (
    schema: string,
    table: string,
    columns: readonly string[],
    make: (parent: Key) => Fact,
  ) => {
    const parent = added("table", schema, table);
    for (const column of columns) added("column", schema, table, column);
    const fact = make(parent);
    catalog.set(constraintKey(parent, fact.name), fact);
  };
  return {
    primaryKey: (schema, table, name, payload) => {
      add(schema, table, payload.columns, (parent) => ({
        kind: "primary key",
        name,
        parent,
        payload,
      }));
    },
    unique: (schema, table, name, payload) => {
      add(schema, table, payload.columns, (parent) => ({
        kind: "unique",
        name,
        parent,
        payload,
      }));
    },
    foreignKey: (schema, table, name, payload) => {
      add(schema, table, payload.columns, (parent) => ({
        kind: "foreign key",
        name,
        parent,
        payload,
      }));
    },
  };
}

/** A foreign key's target may be added after the key, so `build` checks it once all are in. */
function requireTarget(
  { schema, table, columns }: ForeignKeyPayload["target"],
  added: Added,
): void {
  added("table", schema, table);
  for (const column of columns) added("column", schema, table, column);
}

/** The schema, table, or column at a chain of names; a constraint or attribute has no such chain. */
export function factAt(catalog: Catalog, ...names: string[]): Fact | undefined {
  return catalog.get(key(...names));
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
  return fact.kind === "primary key" || fact.kind === "unique" || fact.kind === "foreign key"
    ? constraintKey(fact.parent, fact.name)
    : key(fact.parent, fact.name);
}

export function quoted(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
