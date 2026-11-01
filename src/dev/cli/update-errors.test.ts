import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const UPDATE_FIXTURE = `import { createClient, defineDatabase, defineTable, sql, update } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity("always").primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
declare const client: ReturnType<typeof createClient>;
declare const mode: "always" | "by default";
const users = db.public.users;
const unknownMode = defineDatabase({ public: { t: defineTable((c) => ({ id: c.integer().identity(mode) })) } }).public.t;

void client.run(update(users));
void client.run(update(users).set({ email: "a" }));
void client.all(update(users).set({ email: "a" }).where((u) => u.id.eq(1)));
void client.one(update(users).set({ email: "a" }).allRows().returning((u) => ({ id: u.id })));
void update(users).set({ id: 5 });
void update(unknownMode).set({ id: 5 });
void update(users).set({ nope: "a" });
void update(users).set({ email: null });
void update(users).set({ email: 1 });
void update(users).set({ email: sql.expr<number>\`1\` });
void update(users).set({ email: () => sql.expr<number>\`1\` });
void update(users).set({ email: "a" }).where((u) => u.nope.eq(1));
void update(users).set({ email: "a" }).returning(() => ({}));
void update(users).set({ email: "a" }).allRows().where;
`;

const ROW = "{ id: number; email: string; name: string | null; }";
const CLASSES = '{ id: "number"; email: "text"; name: "text"; }';

describe("Update type errors", () => {
  it("name the call an unfinished update needs, and why an identity always column is refused", async () => {
    const VALUE = `string | ((columns: Refs<${ROW}, ${CLASSES}>) => Expr<string>) | Expr<string>`;
    const UNKNOWN = "error TS2353: Object literal may only specify known properties, and";
    const errors = await typeErrors(UPDATE_FIXTURE);
    const KEY = `"id is generated always, so update can't set it"?: number`;
    expect(errors).toHaveLength(14);
    expect(errors[0]).toMatch(
      /^error TS2741: Property 'toSql' is missing in type 'UpdateNeedsSet<.*' but required in type 'Statement'\.$/u,
    );
    expect(errors.slice(1, 4)).toEqual([
      `error TS2741: Property 'toSql' is missing in type 'UpdateNeedsWhereOrAllRows<${ROW}, ${CLASSES}>' but required in type 'Statement'.`,
      `error TS2345: Argument of type 'FilteredUpdate<${ROW}, ${CLASSES}>' is not assignable to parameter of type 'Query<unknown>'.`,
      `error TS2345: Argument of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & Many' is not assignable to parameter of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & { readonly "~many"?: never; }'.`,
    ]);
    expect(errors[4]).toContain(
      `${UNKNOWN} 'id' does not exist in type '{ email?: ${VALUE}; "id is generated always, so update can't set it"?: number |`,
    );
    expect(errors[5]).toBe(
      `${UNKNOWN} 'id' does not exist in type '{ "id is generated always, so update can't set it"?: number | ((columns: Refs<{ id: number; }, { id: "number"; }>) => Expr<number>) | Expr<number>; }'.`,
    );
    expect(errors[6]).toContain(
      `${UNKNOWN} 'nope' does not exist in type '{ email?: ${VALUE}; "id is generated`,
    );
    expect(errors.slice(7)).toEqual([
      `error TS2322: Type 'null' is not assignable to type '${VALUE}'.`,
      `error TS2322: Type 'number' is not assignable to type '${VALUE}'.`,
      `error TS2322: Type 'Expr<number>' is not assignable to type '${VALUE}'.`,
      `error TS2322: Type '() => Expr<number>' is not assignable to type '${VALUE}'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}, ${CLASSES}>'.`,
      `error TS2339: Property 'returning' does not exist on type 'UpdateNeedsWhereOrAllRows<${ROW}, ${CLASSES}>'.`,
      `error TS2339: Property 'where' does not exist on type 'UpdateStatement<${ROW}, Many>'.`,
    ]);
    expect(errors[4]).toContain(KEY);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });
});
