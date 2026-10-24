import type { Target } from "../../core.ts";
import { defineTable } from "../lib.ts";
import { orders } from "./orders.ts";

// users.ts and orders.ts import each other; the thunk reads `orders` after both modules load.
export const users = defineTable((c) => ({
  id: c.integer().primaryKey(),
  email: c.text().notNull().unique(),
  // users and orders point at each other, so one side of the cycle names its target type.
  favorite_order_id: c
    .integer()
    .references((): Target<number> => orders.columns.id, { onDelete: "set null" }),
}));
