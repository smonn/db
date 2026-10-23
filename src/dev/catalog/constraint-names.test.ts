import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./catalog.ts";

const pkeyCatalog = (table: string) =>
  definitionCatalog(
    defineDatabase({
      public: { [table]: defineTable((c) => ({ id: c.text().primaryKey() })) },
    }),
  );

const keysOf = (catalog: ReturnType<typeof definitionCatalog>) =>
  [...catalog.values()]
    .filter((fact) => fact.kind === "primary key" || fact.kind === "unique")
    .map((fact) => fact.name);

const named = (name: string) =>
  definitionCatalog(
    defineDatabase({
      public: { users: defineTable((c) => ({ email: c.text().unique({ name }) })) },
    }),
  );

describe("a constraint name", () => {
  it("is refused when Postgres would truncate it", () => {
    expect(() => pkeyCatalog("t".repeat(60))).toThrow("is longer than 63 bytes");
  });

  it("is kept at exactly 63 bytes and refused at 64", () => {
    const name = `${"t".repeat(58)}_pkey`;
    expect(name).toHaveLength(63);
    expect([...pkeyCatalog("t".repeat(58)).keys()]).toContain(
      `public\0${"t".repeat(58)}\0\0${name}`,
    );
    expect(() => pkeyCatalog("t".repeat(59))).toThrow("is longer than 63 bytes");
  });

  it("counts bytes, not characters", () => {
    expect(() => pkeyCatalog("é".repeat(29))).not.toThrow();
    expect(() => pkeyCatalog("é".repeat(30))).toThrow("is longer than 63 bytes");
  });
});

describe("an explicit constraint name", () => {
  it("replaces the derived one on a column key, a composite key, and a unique column", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.integer().primaryKey({ name: "pk_users" }),
            email: c.text().unique({ name: "uq_users_email" }),
            handle: c.text().unique(),
          })),
          memberships: defineTable(
            (c) => ({ user_id: c.integer(), team_id: c.integer() }),
            (t) => ({ primaryKey: { name: "pk_memberships", columns: [t.user_id, t.team_id] } }),
          ),
        },
      }),
    );
    expect(keysOf(catalog)).toStrictEqual([
      "pk_users",
      "uq_users_email",
      "users_handle_key",
      "pk_memberships",
    ]);
  });

  it("is refused over 63 bytes or empty", () => {
    expect(() => named("n".repeat(63))).not.toThrow();
    expect(() => named("n".repeat(64))).toThrow("is longer than 63 bytes");
    expect(() => named("")).toThrow(
      'the unique constraint on "public"."users" ("email") has an empty constraint name',
    );
  });
});

describe("two keys in one schema", () => {
  it("can't derive the same name, and the error names both tables and columns", () => {
    const tables = {
      a: defineTable((c) => ({ b_c: c.text().unique() })),
      a_b: defineTable((c) => ({ c: c.text().unique() })),
    };
    expect(() => definitionCatalog(defineDatabase({ public: tables }))).toThrow(
      'the unique constraint on "public"."a" ("b_c") and the unique constraint on "public"."a_b" ("c") both take the constraint name "a_b_c_key"; give one of them another name with primaryKey({ name }), unique({ name }), or { name, columns }',
    );
  });

  it("can't take one name, explicit or derived, across a primary key and a unique constraint", () => {
    const tables = {
      users: defineTable((c) => ({ id: c.integer().primaryKey() })),
      accounts: defineTable((c) => ({ email: c.text().unique({ name: "users_pkey" }) })),
    };
    expect(() => definitionCatalog(defineDatabase({ public: tables }))).toThrow(
      'the primary key on "public"."users" ("id") and the unique constraint on "public"."accounts" ("email") both take the constraint name "users_pkey"',
    );
    const pairs = {
      pairs: defineTable(
        (c) => ({ a: c.integer(), b: c.integer().unique({ name: "pk_pairs" }) }),
        (t) => ({ primaryKey: { name: "pk_pairs", columns: [t.a, t.b] } }),
      ),
    };
    expect(() => definitionCatalog(defineDatabase({ public: pairs }))).toThrow(
      'the primary key on "public"."pairs" ("a", "b") and the unique constraint on "public"."pairs" ("b") both take',
    );
  });

  it("can take one name once either is named, or in different schemas", () => {
    const renamed = {
      a: defineTable((c) => ({ b_c: c.text().unique({ name: "a_bc_key" }) })),
      a_b: defineTable((c) => ({ c: c.text().unique() })),
    };
    expect(keysOf(definitionCatalog(defineDatabase({ public: renamed })))).toStrictEqual([
      "a_bc_key",
      "a_b_c_key",
    ]);
    const apart = defineDatabase({
      public: { a: defineTable((c) => ({ b_c: c.text().unique() })) },
      auth: { a_b: defineTable((c) => ({ c: c.text().unique() })) },
    });
    expect(keysOf(definitionCatalog(apart))).toStrictEqual(["a_b_c_key", "a_b_c_key"]);
  });
});
