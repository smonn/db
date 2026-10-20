import type { ColumnFactories } from "../lib.ts";

// A shared column helper: a plain function of the factories.
export const createdAt = (c: ColumnFactories) => ({
  created_at: c.timestamptz().notNull().default(c.sql`now()`),
});
