import { defineTable } from "../lib.ts";

// Composite key columns are NOT NULL without saying so, as in Postgres.
export const sessions = defineTable(
  (c) => ({
    user_id: c.uuid(),
    token: c.text(),
    expires_at: c.timestamptz().notNull(),
  }),
  { primaryKey: ["user_id", "token"] },
);
