import { defineTable } from "../lib.ts";
import { users } from "./users.ts";

export const orders = defineTable(
  (c) => ({
    id: c.integer().primaryKey(),
    user_id: c.integer().notNull(),
  }),
  (t) => ({
    foreignKeys: [
      { columns: [t.user_id], references: () => [users.columns.id], onDelete: "cascade" },
    ],
  }),
);
