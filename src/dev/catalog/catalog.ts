import { quoteIdentifier } from "../../runtime/internal/index.ts";
import {
  DEFAULT_NAME,
  GENERATED_NAME,
  IDENTITY_NAME,
  type Catalog,
  type Fact,
  type Key,
} from "./fact.ts";
import type {
  ColumnPayload,
  DefaultPayload,
  DomainCheckPayload,
  DomainPayload,
  EnumPayload,
  ForeignKeyPayload,
  GeneratedPayload,
  IdentityPayload,
  IndexPayload,
  PrimaryKeyPayload,
  UniquePayload,
} from "./payloads.ts";

/** A fact on a column, before the builder gives it its parent. */
type ColumnAttribute = Fact extends infer F
  ? F extends { readonly kind: "default" | "identity" | "generated" }
    ? Omit<F, "parent">
    : never
  : never;

export type CatalogBuilder = {
  schema(name: string): void;
  table(schema: string, name: string): void;
  enumType(schema: string, name: string, payload: EnumPayload): void;
  domain(schema: string, name: string, payload: DomainPayload): void;
  domainCheck(schema: string, domain: string, name: string, payload: DomainCheckPayload): void;
  column(schema: string, table: string, name: string, payload: ColumnPayload): void;
  columnDefault(schema: string, table: string, column: string, payload: DefaultPayload): void;
  columnIdentity(schema: string, table: string, column: string, payload: IdentityPayload): void;
  columnGenerated(schema: string, table: string, column: string, payload: GeneratedPayload): void;
  primaryKey(schema: string, table: string, name: string, payload: PrimaryKeyPayload): void;
  unique(schema: string, table: string, name: string, payload: UniquePayload): void;
  index(schema: string, table: string, name: string, payload: IndexPayload): void;
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
    ...typeMethods(catalog, added),
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

/** Enums and domains sit under their schema, keyed like a table, since they share its names. */
function typeMethods(
  catalog: Map<Key, Fact>,
  added: Added,
): Pick<CatalogBuilder, "enumType" | "domain" | "domainCheck"> {
  return {
    enumType(schema, name, payload) {
      const parent = added("schema", schema);
      catalog.set(key(schema, name), { kind: "enum", name, parent, payload });
    },
    domain(schema, name, payload) {
      const parent = added("schema", schema);
      catalog.set(key(schema, name), { kind: "domain", name, parent, payload });
    },
    domainCheck(schema, domain, name, payload) {
      const parent = added("domain", schema, domain);
      catalog.set(key(schema, domain, name), { kind: "domain check", name, parent, payload });
    },
  };
}

function constraintMethods(
  catalog: Map<Key, Fact>,
  added: Added,
): Pick<CatalogBuilder, "primaryKey" | "unique" | "index" | "foreignKey"> {
  const add = (
    schema: string,
    table: string,
    columns: readonly string[],
    make: (parent: Key) => Fact,
  ) => {
    const parent = added("table", schema, table);
    for (const column of columns) added("column", schema, table, column);
    const fact = make(parent);
    catalog.set(keyOf(fact), fact);
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
    index: (schema, table, name, payload) => {
      add(
        schema,
        table,
        [...payload.keys.map(({ column }) => column), ...payload.include],
        (parent) => ({ kind: "index", name, parent, payload }),
      );
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
 * same name on its table. An index shares its schema's relation names, not the table's constraint
 * names, so it keys under a segment of its own.
 */
function constraintKey(table: Key, name: string, kind: Fact["kind"]): Key {
  return kind === "index" ? key(table, "", "index", name) : key(table, "", name);
}

function keyOf(fact: Fact): Key {
  if (fact.parent === undefined) return key(fact.name);
  return fact.kind === "primary key" ||
    fact.kind === "unique" ||
    fact.kind === "index" ||
    fact.kind === "foreign key"
    ? constraintKey(fact.parent, fact.name, fact.kind)
    : key(fact.parent, fact.name);
}

export function quoted(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(".");
}
