import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";

describe("onConflict errors", () => {
  it("quotes and qualifies the mapped target of a foreign-table assignment", () => {
    const db = defineDatabase({
      's"chema': {
        't"able': defineTable((c) => ({
          id: c.integer().primaryKey(),
          propertyName: c.text().notNull().name('c"ol'),
        })),
      },
      public: { other: defineTable((c) => ({ value: c.text().notNull() })) },
    });
    const conflict = insert(db['s"chema']['t"able'])
      .values({ id: 1, propertyName: "value" })
      .onConflict((u) => [u.id]);

    void from(db.public.other).select((other) => {
      expect(() => conflict.doUpdate(() => ({ propertyName: other.value }))).toThrow(
        'doUpdate: "s""chema"."t""able"."c""ol" takes a column of another table',
      );
      return { value: other.value };
    });
  });
});
