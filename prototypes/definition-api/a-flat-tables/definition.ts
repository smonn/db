import {
  bigint,
  boolean,
  bytea,
  date,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  real,
  schema,
  smallint,
  sql,
  table,
  text,
  timestamp,
  timestamptz,
  uuid,
  varchar,
} from "./db.ts";
import type { OrderMetadata } from "../expected.ts";

export const users = table("users", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  email: varchar(320).unique(),
  display_name: text().nullable(),
  age: smallint().nullable(),
  is_admin: boolean().default(false),
  created_at: timestamptz().default(sql`now()`),
});

export const orders = table("orders", {
  id: bigint().generatedAlwaysAsIdentity().primaryKey(),
  user_id: uuid(),
  total: numeric(12, 2),
  quantity: integer().default(1),
  weight_kg: real().nullable(),
  rating: doublePrecision().nullable(),
  placed_on: date(),
  shipped_at: timestamp().nullable(),
  metadata: jsonb<OrderMetadata>().default({}),
  receipt_pdf: bytea().nullable(),
});

const auth = schema("auth");

export const sessions = auth.table(
  "sessions",
  {
    user_id: uuid(),
    token: text(),
    expires_at: timestamptz(),
  },
  { primaryKey: ["user_id", "token"] },
);
