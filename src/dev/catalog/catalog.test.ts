import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import {
  catalogBuilder,
  childrenOf,
  definitionCatalog,
  namesOf,
  parentOf,
  type Catalog,
  type CatalogBuilder,
  type Fact,
} from "./catalog.ts";

describe("definitionCatalog", () => {
  it("has a fact per schema, table, and column, keyed by their chain of names", () => {
    const users = defineTable((c) => ({ id: c.text().notNull(), email: c.text() }));
    const sessions = defineTable((c) => ({ token: c.text() }));
    const catalog = definitionCatalog(defineDatabase({ public: { users }, auth: { sessions } }));

    expect([...catalog]).toStrictEqual([
      ["public", { kind: "schema", name: "public", parent: undefined, payload: {} }],
      ["public\0users", { kind: "table", name: "users", parent: "public", payload: {} }],
      [
        "public\0users\0id",
        {
          kind: "column",
          name: "id",
          parent: "public\0users",
          payload: { type: "text", notNull: true },
        },
      ],
      [
        "public\0users\0email",
        {
          kind: "column",
          name: "email",
          parent: "public\0users",
          payload: { type: "text", notNull: false },
        },
      ],
      ["auth", { kind: "schema", name: "auth", parent: undefined, payload: {} }],
      ["auth\0sessions", { kind: "table", name: "sessions", parent: "auth", payload: {} }],
      [
        "auth\0sessions\0token",
        {
          kind: "column",
          name: "token",
          parent: "auth\0sessions",
          payload: { type: "text", notNull: false },
        },
      ],
    ]);
  });

  it("names every column type the way Postgres reports it", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          all: defineTable((c) => ({
            text: c.text(),
            varchar: c.varchar(20),
            smallint: c.smallint(),
            integer: c.integer(),
            bigint: c.bigint(),
            numeric: c.numeric(),
            numericP: c.numeric(10),
            numericPS: c.numeric(10, 2),
            real: c.real(),
            doublePrecision: c.doublePrecision(),
            boolean: c.boolean(),
            uuid: c.uuid(),
            date: c.date(),
            timestamp: c.timestamp(),
            timestamptz: c.timestamptz(),
            jsonb: c.jsonb(),
            bytea: c.bytea(),
          })),
        },
      }),
    );

    const types = [...catalog.values()]
      .filter((fact) => fact.kind === "column")
      .map((fact) => [fact.name, fact.payload.type]);
    expect(Object.fromEntries(types)).toStrictEqual({
      text: "text",
      varchar: "character varying(20)",
      smallint: "smallint",
      integer: "integer",
      bigint: "bigint",
      numeric: "numeric",
      numericP: "numeric(10,0)",
      numericPS: "numeric(10,2)",
      real: "real",
      doublePrecision: "double precision",
      boolean: "boolean",
      uuid: "uuid",
      date: "date",
      timestamp: "timestamp without time zone",
      timestamptz: "timestamp with time zone",
      jsonb: "jsonb",
      bytea: "bytea",
    });
  });

  it("adds default, identity, primary key, and unique facts with Postgres's constraint names", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          users: defineTable(
            (c) => ({
              a: c.integer().identity("always"),
              b: c.integer(),
              c: c.text().default("'new'").unique(),
            }),
            (t) => ({ primaryKey: [t.a, t.b] }),
          ),
        },
      }),
    );

    expect(
      Object.fromEntries([...catalog].map(([k, f]) => [k.replaceAll("\0", "."), f.payload])),
    ).toMatchObject({
      "public.users.a": { type: "integer", notNull: true },
      "public.users.b": { type: "integer", notNull: true },
      "public.users.c": { type: "text", notNull: false },
      "public.users.a.identity": { generated: "always" },
      "public.users.c.default": { expression: "'new'", volatile: false },
      "public.users..users_pkey": { columns: ["a", "b"] },
      "public.users..users_c_key": { column: "c" },
    });
  });

  it("keeps a schema with no tables", () => {
    expect([...definitionCatalog(defineDatabase({ empty: {} }))]).toStrictEqual([
      ["empty", { kind: "schema", name: "empty", parent: undefined, payload: {} }],
    ]);
  });
});

describe("catalogBuilder", () => {
  it("refuses a table or column whose parent it hasn't added, naming it", () => {
    const builder = catalogBuilder();
    expect(() => {
      builder.table("auth", "users");
    }).toThrow(`schema "auth" isn't in the catalog`);
    builder.schema("auth");
    expect(() => {
      builder.column("auth", "users", "id", { type: "text", notNull: false });
    }).toThrow(`table "auth"."users" isn't in the catalog`);
  });

  it("keeps a default and an identity as facts under their column", () => {
    const builder = catalogBuilder();
    builder.schema("public");
    builder.table("public", "users");
    builder.column("public", "users", "id", { type: "integer", notNull: true });
    builder.columnIdentity("public", "users", "id", { generated: "always" });
    builder.column("public", "users", "role", { type: "text", notNull: false });
    builder.columnDefault("public", "users", "role", {
      expression: "'member'::text",
      volatile: false,
    });
    const catalog = builder.build();

    expect([...catalog.keys()].slice(2)).toStrictEqual([
      "public\0users\0id",
      "public\0users\0id\0identity",
      "public\0users\0role",
      "public\0users\0role\0default",
    ]);
    expect([...catalog.values()].at(-1)).toStrictEqual({
      kind: "default",
      name: "default",
      parent: "public\0users\0role",
      payload: { expression: "'member'::text", volatile: false },
    });
  });

  it("refuses a default or identity on a column it hasn't added, naming it", () => {
    const builder = catalogBuilder();
    builder.schema("public");
    builder.table("public", "users");
    expect(() => {
      builder.columnDefault("public", "users", "role", { expression: "1", volatile: false });
    }).toThrow(`column "public"."users"."role" isn't in the catalog`);
    expect(() => {
      builder.columnIdentity("public", "users", "id", { generated: "always" });
    }).toThrow(`column "public"."users"."id" isn't in the catalog`);
  });
});

function usersBuilder(): CatalogBuilder {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: "integer", notNull: true });
  builder.column("public", "users", "email", { type: "text", notNull: false });
  return builder;
}

function tableFact(catalog: Catalog): Fact {
  const found = [...catalog.values()].find((fact) => fact.kind === "table");
  if (found === undefined) throw new Error("no table in the catalog");
  return found;
}

describe("keys", () => {
  it("keeps a primary key and a unique constraint as facts under their table, by constraint name", () => {
    const builder = usersBuilder();
    builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
    builder.unique("public", "users", "users_email_key", { column: "email" });
    const catalog = builder.build();

    expect([...catalog.values()].slice(-2)).toStrictEqual([
      {
        kind: "primary key",
        name: "users_pkey",
        parent: "public\0users",
        payload: { columns: ["id"] },
      },
      {
        kind: "unique",
        name: "users_email_key",
        parent: "public\0users",
        payload: { column: "email" },
      },
    ]);
    expect(childrenOf(catalog, tableFact(catalog)).map((fact) => fact.kind)).toStrictEqual([
      "column",
      "column",
      "primary key",
      "unique",
    ]);
  });

  it("keys a constraint apart from a column of the same name", () => {
    const builder = usersBuilder();
    builder.unique("public", "users", "email", { column: "email" });
    const catalog = builder.build();

    expect(catalog.size).toBe(5);
    expect(childrenOf(catalog, tableFact(catalog)).map((fact) => fact.kind)).toStrictEqual([
      "column",
      "column",
      "unique",
    ]);
    expect(catalog.size).toBe(5);
  });

  it("refuses a key on a table or column it hasn't added, naming it", () => {
    const builder = usersBuilder();
    expect(() => {
      builder.primaryKey("public", "users", "pk", { columns: ["id", "gone"] });
    }).toThrow(`column "public"."users"."gone" isn't in the catalog`);
    expect(() => {
      builder.unique("public", "users", "u", { column: "gone" });
    }).toThrow(`column "public"."users"."gone" isn't in the catalog`);
    expect(() => {
      builder.unique("public", "missing", "u", { column: "id" });
    }).toThrow(`table "public"."missing" isn't in the catalog`);
  });
});

describe("lookups", () => {
  const users = defineTable((c) => ({ id: c.text(), email: c.text() }));
  const catalog = definitionCatalog(
    defineDatabase({ public: { users, empty: defineTable(() => ({})) } }),
  );
  const fact = (name: string) => [...catalog.values()].find((f) => f.name === name)!;

  it("finds a fact's parent and its children in catalog order", () => {
    expect(parentOf(catalog, fact("email"))).toBe(fact("users"));
    expect(childrenOf(catalog, fact("users"))).toStrictEqual([fact("id"), fact("email")]);
    expect(childrenOf(catalog, fact("empty"))).toStrictEqual([]);
  });

  it("names a fact from its schema down", () => {
    expect(namesOf(catalog, fact("email"))).toStrictEqual(["public", "users", "email"]);
    expect(namesOf(catalog, fact("public"))).toStrictEqual(["public"]);
  });

  it("refuses the parent of a schema", () => {
    expect(() => parentOf(catalog, fact("public"))).toThrow(`schema "public" has no parent`);
  });
});
