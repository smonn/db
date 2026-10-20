import { defineTable } from "../lib.ts";
import type { OrderMetadata } from "../../expected.ts";

export const orders = defineTable((c) => ({
  id: c.bigint().generatedAlwaysAsIdentity().primaryKey(),
  user_id: c.uuid().notNull(),
  total: c.numeric(12, 2).notNull(),
  quantity: c.integer().notNull().default(1),
  weight_kg: c.real(),
  rating: c.doublePrecision(),
  placed_on: c.date().notNull(),
  shipped_at: c.timestamp(),
  metadata: c.jsonb<OrderMetadata>().notNull().default({}),
  receipt_pdf: c.bytea(),
}));
