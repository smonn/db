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

/** Schemas and tables carry nothing beyond their name in v0.1. */
type NoPayload = Readonly<Record<string, never>>;

/** Type-only: only `catalog.ts` builds keys, so every producer keys a chain of names the same way. */
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
      /** Keyed like a table, since a type and a table share one pool of names. */
      readonly kind: "domain";
      readonly name: string;
      readonly parent: Key;
      readonly payload: DomainPayload;
    }
  | {
      /** Named by its constraint, under its domain. */
      readonly kind: "domain check";
      readonly name: string;
      readonly parent: Key;
      readonly payload: DomainCheckPayload;
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
      /** Named by its index, which shares the schema's relation names. */
      readonly kind: "index";
      readonly name: string;
      readonly parent: Key;
      readonly payload: IndexPayload;
    }
  | {
      /** Named by its constraint; the payload names its target by schema, table, and columns. */
      readonly kind: "foreign key";
      readonly name: string;
      readonly parent: Key;
      readonly payload: ForeignKeyPayload;
    };

/** A column has at most one default, identity, and generation expression, so their names are fixed. */
export const DEFAULT_NAME = "default";
export const IDENTITY_NAME = "identity";
export const GENERATED_NAME = "generated";

/**
 * Every modeled object, keyed by the chain of names from its schema down. The payload leaves out
 * the name, so a rename can be detected later.
 */
export type Catalog = ReadonlyMap<Key, Fact>;
