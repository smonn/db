import { schema, table } from "./db.ts";
import type { OrderMetadata } from "../expected.ts";

export const users = table("users", (c) => ({
  id: c.uuid().primaryKey().default(c.sql`gen_random_uuid()`),
  email: c.varchar(320).unique(),
  display_name: c.text().nullable(),
  age: c.smallint().nullable(),
  is_admin: c.boolean().default(false),
  created_at: c.timestamptz().default(c.sql`now()`),
}));

export const orders = table("orders", (c) => ({
  id: c.bigint().generatedAlwaysAsIdentity().primaryKey(),
  user_id: c.uuid(),
  total: c.numeric(12, 2),
  quantity: c.integer().default(1),
  weight_kg: c.real().nullable(),
  rating: c.doublePrecision().nullable(),
  placed_on: c.date(),
  shipped_at: c.timestamp().nullable(),
  metadata: c.jsonb<OrderMetadata>().default({}),
  receipt_pdf: c.bytea().nullable(),
}));

const auth = schema("auth");

export const sessions = auth.table(
  "sessions",
  (c) => ({
    user_id: c.uuid(),
    token: c.text(),
    expires_at: c.timestamptz(),
  }),
  { primaryKey: ["user_id", "token"] },
);
