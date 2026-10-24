import type { Target } from "../../core.ts";
import { defineTable } from "../lib.ts";
import { orders } from "./orders.ts";

export const users = defineTable(
  (c) => ({
    id: c.integer().primaryKey(),
    email: c.text().notNull().unique(),
    favorite_order_id: c.integer(),
  }),
  (t) => ({
    foreignKeys: [
      {
        columns: [t.favorite_order_id],
        // users and orders point at each other, so one side of the cycle names its target type.
        references: (): readonly [Target<number>] => [orders.columns.id],
        onDelete: "set null",
      },
    ],
  }),
);
