import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const FIXTURE = `import { createClient, defineDatabase, defineTable, from, insert, type SelectQuery } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
declare const client: ReturnType<typeof createClient>;

void client.run(insert(db.public.users));
export const wrong: SelectQuery<{ id: string }> = from(db.public.users);
void from(db.public.users).where((u) => u.nope.isNull());
`;

const ORDER_FIXTURE = `import { defineDatabase, defineTable, from } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
const users = from(db.public.users);

void users.orderBy((u) => u.email.asc({ nulls: "first" }));
void users.orderBy((u) => u.id.desc({ nulls: "last" }));
void users.orderBy((u) => u.name.asc({ nulls: "middle" }));
void users.orderBy((u) => u.nope);
void users.orderBy((u) => u.name.eq("a"));
void users.orderBy((u) => [u.id, "name"]);
void users.limit("5");
void users.offset(null);
void users.limit();
`;

const PICK_FIXTURE = `import { defineDatabase, defineTable, from } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
const users = from(db.public.users);

void users.pick("nope");
void users.pick("id", "nope");
void users.pick();
void users.pick(1);
`;

const VALUES_FIXTURE = `import { defineDatabase, defineTable, insert } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
const users = insert(db.public.users);

void users.values({ email: "a", nope: 1 });
void users.values({ name: "a" });
void users.values({ email: 1 });
void users.values([{ email: "a" }]);
void users.valuesMany([{ email: "a", nope: 1 }]);
void users.valuesMany([{ name: "a" }]);
void users.valuesMany([{ email: 1 }]);
void users.valuesMany({ email: "a" });
`;

const MATCH_FIXTURE = `import { defineDatabase, defineEnum, defineTable, from } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      role: c.enum(defineEnum(["admin", "member"])).notNull(),
      tags: c.text().array().notNull(),
    })),
  },
});
const users = from(db.public.users);

void users.where((u) => u.id.like("1%"));
void users.where((u) => u.role.ilike("a%"));
void users.where((u) => u.tags.like("a%"));
void users.where((u) => u.tags.in([["a"]]));
void users.where((u) => u.tags.notIn([["a"]]));
void users.where((u) => u.email.includes("a"));
void users.where((u) => u.id.in(["1"]));
void users.where((u) => u.email.in([null]));
void users.where((u) => u.tags.includes(1));
`;

const DELETE_FIXTURE = `import { createClient, defineDatabase, defineTable, deleteFrom } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
declare const client: ReturnType<typeof createClient>;
const users = db.public.users;

void client.run(deleteFrom(users));
void client.all(deleteFrom(users).where((u) => u.id.eq(1)));
void client.one(deleteFrom(users).where((u) => u.id.eq(1)));
void client.one(deleteFrom(users).allRows().returning((u) => ({ id: u.id })));
void deleteFrom(users).where((u) => u.nope.eq(1));
void deleteFrom(users).where((u) => u.email.eq(1));
void deleteFrom(users).where((u) => u.id.like("1%"));
void deleteFrom(users).returning(() => ({}));
void deleteFrom(users).allRows().where;
`;

const ROW = "{ id: number; email: string; name: string | null; }";
const CLASSES = '{ id: "number"; email: "text"; name: "text"; }';
const NEW_ROW = "{ email: string; id?: number; name?: string | null; }";

describe("Builder type errors", () => {
  it("print rows, and name the call an unfinished insert needs", async () => {
    expect(await typeErrors(FIXTURE)).toEqual([
      `error TS2741: Property 'toSql' is missing in type 'InsertNeedsValues<${ROW}, ${NEW_ROW}>' but required in type 'Statement'.`,
      `error TS2322: Type 'SelectQuery<${ROW}, ${ROW}, ${CLASSES}>' is not assignable to type 'SelectQuery<{ id: string; }>'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}, ${CLASSES}>'.`,
    ]);
  });

  it("name nulls on a NOT NULL column, and print the row for a wrong ordering or count", async () => {
    const errors = await typeErrors(ORDER_FIXTURE);
    const NOT_NULLABLE = `'nulls' does not exist in type '{ readonly "nulls needs a nullable column"?: never; }'.`;
    expect(errors).toEqual([
      `error TS2353: Object literal may only specify known properties, and ${NOT_NULLABLE}`,
      `error TS2353: Object literal may only specify known properties, and ${NOT_NULLABLE}`,
      `error TS2322: Type '"middle"' is not assignable to type '"first" | "last" | undefined'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}, ${CLASSES}>'.`,
      `error TS2322: Type 'Predicate' is not assignable to type 'readonly Orderable[] | Orderable'.`,
      `error TS2322: Type 'string' is not assignable to type 'Orderable'.`,
      `error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
      `error TS2345: Argument of type 'null' is not assignable to parameter of type 'number'.`,
      `error TS2554: Expected 1 arguments, but got 0.`,
    ]);
    expect(errors.filter((line) => line.includes("Table<"))).toEqual([]);
  });

  it("name the bad key of one row or many, with no overload to blame", async () => {
    const errors = await typeErrors(VALUES_FIXTURE);
    const MISSING = `error TS2741: Property 'email' is missing in type '{ name: string; }' but required in type '${NEW_ROW}'.`;
    const UNKNOWN = `error TS2353: Object literal may only specify known properties, and 'nope' does not exist in type '${NEW_ROW}'.`;
    const WRONG_TYPE = `error TS2322: Type 'number' is not assignable to type 'string'.`;
    expect(errors).toEqual([
      UNKNOWN,
      MISSING,
      WRONG_TYPE,
      `error TS2741: Property 'email' is missing in type '{ email: string; }[]' but required in type '${NEW_ROW}'.`,
      UNKNOWN,
      MISSING,
      WRONG_TYPE,
      `error TS2353: Object literal may only specify known properties, and 'email' does not exist in type 'readonly ${NEW_ROW}[]'.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });

  it("print the valid keys for a wrong name, with no overload to blame", async () => {
    const KEYS = `'"email" | "id" | "name"'`;
    const errors = await typeErrors(PICK_FIXTURE);
    expect(errors).toEqual([
      `error TS2345: Argument of type '"nope"' is not assignable to parameter of type ${KEYS}.`,
      `error TS2345: Argument of type '"nope"' is not assignable to parameter of type ${KEYS}.`,
      `error TS2555: Expected at least 1 arguments, but got 0.`,
      `error TS2345: Argument of type '1' is not assignable to parameter of type ${KEYS}.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });

  it("hide a call its column can't take, and name the bad element", async () => {
    const errors = await typeErrors(MATCH_FIXTURE);
    expect(errors).toEqual([
      `error TS2339: Property 'like' does not exist on type 'ColumnRef<number, "number">'.`,
      `error TS2339: Property 'ilike' does not exist on type 'ColumnRef<"admin" | "member", "enum">'.`,
      `error TS2339: Property 'like' does not exist on type 'ColumnRef<(string | null)[], "text[]">'.`,
      `error TS2339: Property 'in' does not exist on type 'ColumnRef<(string | null)[], "text[]">'.`,
      `error TS2339: Property 'notIn' does not exist on type 'ColumnRef<(string | null)[], "text[]">'.`,
      `error TS2339: Property 'includes' does not exist on type 'ColumnRef<string, "text">'.`,
      `error TS2322: Type 'string' is not assignable to type 'number'.`,
      `error TS2322: Type 'null' is not assignable to type 'string'.`,
      `error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });

  it("name the call an unfinished delete needs, and print the row for the rest", async () => {
    const BUILDER = `DeleteNeedsWhereOrAllRows<${ROW}, ${CLASSES}>`;
    const FILTERED = `FilteredDelete<${ROW}, ${CLASSES}>`;
    const errors = await typeErrors(DELETE_FIXTURE);
    expect(errors).toEqual([
      `error TS2741: Property 'toSql' is missing in type '${BUILDER}' but required in type 'Statement'.`,
      `error TS2345: Argument of type '${FILTERED}' is not assignable to parameter of type 'Query<unknown>'.`,
      `error TS2345: Argument of type '${FILTERED}' is not assignable to parameter of type 'Statement & { readonly "~returns": "rows"; readonly "~row": unknown; } & { readonly "~many"?: never; }'.`,
      `error TS2345: Argument of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & Many' is not assignable to parameter of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & { readonly "~many"?: never; }'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}, ${CLASSES}>'.`,
      `error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.`,
      `error TS2339: Property 'like' does not exist on type 'ColumnRef<number, "number">'.`,
      `error TS2339: Property 'returning' does not exist on type '${BUILDER}'.`,
      `error TS2339: Property 'where' does not exist on type 'DeleteStatement<${ROW}, Many>'.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });
});
