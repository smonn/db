import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const UPSERT_FIXTURE = `import { createClient, defineDatabase, defineEnum, defineTable, insert, sql } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    items: defineTable(
      (c) => ({
        id: c.integer().identity("always").primaryKey(),
        sku: c.text().notNull().unique(),
        a: c.text(),
        b: c.text(),
        mood: c.enum(defineEnum(["happy", "sad"])),
      }),
      (t) => ({ unique: [{ columns: [t.a, t.b] }] }),
    ),
    twice: defineTable(
      (c) => ({ tag: c.text(), gone: c.boolean() }),
      (t) => ({
        indexes: [
          { columns: [t.tag], unique: true, where: sql\`\${t.gone}\` },
          { columns: [t.tag], unique: true, where: sql\`not \${t.gone}\` },
        ],
      }),
    ),
  },
});
declare const client: ReturnType<typeof createClient>;
const { items, twice } = db.public;
const conflict = insert(items).values({ sku: "s" }).onConflict((u) => [u.sku]);

void insert(items).values({ sku: "s" }).onConflict((u) => [u.a]);
void insert(items).values({ sku: "s" }).onConflict((u) => [u.a, u.mood]);
void insert(twice).values({ tag: "t" }).onConflict((u) => [u.tag]);
void client.run(conflict);
void client.one(conflict.doNothing().returning((u) => ({ id: u.id })));
void client.one(conflict.doUpdate(() => ({ a: "x" })).where((e) => e.a.isNull()).returning((u) => ({ id: u.id })));
void conflict.doUpdate(() => ({ nope: 1 }));
void conflict.doUpdate(() => ({ id: 3 }));
void conflict.doUpdate(() => ({ sku: 1 }));
void conflict.doUpdate((_, excluded) => ({ sku: excluded.a }));
void conflict.doUpdate((_, excluded) => ({ mood: excluded.a }));
void conflict.doNothing().onConflict;
void conflict.doUpdate(() => ({ a: "x" })).where((e) => e.nope.isNull());
`;

describe("Upsert type errors", () => {
  it("name a target that is no key, and print rows for each misuse of a conflict clause", async () => {
    const ROW =
      '{ id: number; sku: string; a: string | null; b: string | null; mood: "happy" | "sad" | null; }';
    const CLASSES = '{ id: "number"; sku: "text"; a: "text"; b: "text"; mood: "enum"; }';
    const TO_ONE = `error TS2345: Argument of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & Maybe' is not assignable to parameter of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number, SqlClass>; }>; } & { readonly "~many"?: never; readonly "~maybe"?: never; }'.`;
    const SKU = `'string | ColumnOf<string, "text"> | Expr<string> | undefined'`;
    const errors = await typeErrors(UPSERT_FIXTURE);
    expect(errors).toEqual([
      `error TS2322: Type 'readonly [ConflictRef<"a">]' is not assignable to type 'readonly [ConflictRef<"a">] & Refusal<"(a) is not a key of the table">'.`,
      `error TS2322: Type 'readonly [ConflictRef<"a">, ConflictRef<"mood">]' is not assignable to type 'readonly [ConflictRef<"a">, ConflictRef<"mood">] & Refusal<"(a, mood) is not a key of the table">'.`,
      `error TS2322: Type 'readonly [ConflictRef<"tag">]' is not assignable to type 'readonly [ConflictRef<"tag">] & Refusal<"(tag) has several partial unique indexes and no full key">'.`,
      `error TS2741: Property 'toSql' is missing in type 'OnConflict<${ROW}, ${CLASSES}, "id", unknown>' but required in type 'Statement'.`,
      TO_ONE,
      TO_ONE,
      `error TS2322: Type 'number' is not assignable to type '"nope is not a column"'.`,
      `error TS2322: Type 'number' is not assignable to type '"id is generated always, so update can't set it"'.`,
      `error TS2322: Type 'number' is not assignable to type ${SKU}.`,
      `error TS2322: Type 'ColumnRef<string | null, "text">' is not assignable to type ${SKU}.`,
      `error TS2322: Type 'ColumnRef<string | null, "text">' is not assignable to type '"happy" | "sad" | ColumnOf<"happy" | "sad" | null, "enum"> | Expr<"happy" | "sad" | null> | null | undefined'.`,
      `error TS2339: Property 'onConflict' does not exist on type 'ConflictStatement<${ROW}, Maybe>'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}, ${CLASSES}>'.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });
});
