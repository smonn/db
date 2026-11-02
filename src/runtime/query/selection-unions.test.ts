import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { deleteFrom } from "./delete.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import type { Refs } from "./refs.ts";
import { sql } from "./sql.ts";

const db = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.integer().notNull(), email: c.text() })) },
});

const choose = (useColumn: boolean) => (u: Refs<{ email: string | null }>) => ({
  value: useColumn ? u.email : sql.expr<number>`1`,
});

describe("a selection choosing a column or an Expr", () => {
  it.each([
    { useColumn: true, text: 'select "email" as "value" from "public"."users"' },
    { useColumn: false, text: 'select (1) as "value" from "public"."users"' },
  ])("keeps both value types and nullability ($useColumn)", ({ useColumn, text }) => {
    const selected = from(db.public.users).select(choose(useColumn));
    const inserted = insert(db.public.users).values({ id: 1 }).returning(choose(useColumn));
    const deleted = deleteFrom(db.public.users)
      .where((u) => u.id.eq(1))
      .returning(choose(useColumn));

    expectTypeOf<(typeof selected)["~row"]>().toEqualTypeOf<{ value: string | number | null }>();
    expectTypeOf<(typeof inserted)["~row"]>().toEqualTypeOf<{ value: string | number | null }>();
    expectTypeOf<(typeof deleted)["~row"]>().toEqualTypeOf<{ value: string | number | null }>();
    expect(selected.toSql().text).toBe(text);
  });
});
