import { defineTable } from "../lib.ts";
import { users } from "./users.ts";

export const orders = defineTable((c) => ({
  id: c.integer().primaryKey(),
  user_id: c
    .integer()
    .notNull()
    .references(() => users.columns.id, { onDelete: "cascade" }),
}));
