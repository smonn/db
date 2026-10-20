// The Database every variant queries: the same tables as the Definition
// prototype.

import { defineDatabase, defineTable, type ColumnFactories } from "./definition.ts";

export type OrderMetadata = { gift: boolean; note?: string };

const createdAt = (c: ColumnFactories) => ({
  created_at: c.timestamptz().notNull().default(c.sql`now()`),
});

const users = defineTable((c) => ({
  id: c.uuid().primaryKey().default(c.sql`gen_random_uuid()`),
  email: c.varchar(320).notNull().unique(),
  display_name: c.text(),
  age: c.smallint(),
  is_admin: c.boolean().notNull().default(false),
  ...createdAt(c),
}));

const orders = defineTable((c) => ({
  id: c.bigint().generatedAlwaysAsIdentity().primaryKey(),
  user_id: c.uuid().notNull(),
  total: c.numeric(12, 2).notNull(),
  quantity: c.integer().notNull().default(1),
  placed_on: c.date().notNull(),
  shipped_at: c.timestamp(),
  metadata: c.jsonb<OrderMetadata>().notNull().default({ gift: false }),
}));

const sessions = defineTable(
  (c) => ({
    user_id: c.uuid(),
    token: c.text(),
    expires_at: c.timestamptz().notNull(),
  }),
  { primaryKey: ["user_id", "token"] },
);

export default defineDatabase({
  public: { users, orders },
  auth: { sessions },
});
