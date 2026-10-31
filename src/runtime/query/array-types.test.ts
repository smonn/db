import { describe, expectTypeOf, it } from "vitest";
import { defineDatabase, defineEnum, defineTable } from "../definition/index.ts";
import type { NewRow } from "./index.ts";

describe("array columns", () => {
  it("type as (V | null)[] in NewRow, optional when the column is nullable or defaulted", () => {
    const mood = defineEnum(["sad", "ok"]);
    const db = defineDatabase({
      public: {
        mood,
        t: defineTable((c) => ({
          required: c.text().array().notNull(),
          defaulted: c.integer().array().notNull().default("'{}'"),
          nullable: c.enum(mood).array(),
        })),
      },
    });

    expectTypeOf<NewRow<typeof db.public.t>>().toEqualTypeOf<
      { required: (string | null)[] } & {
        defaulted?: (number | null)[];
        nullable?: ("sad" | "ok" | null)[] | null;
      }
    >();
  });
});
