import { defineTable } from "./lib.ts";

// No table imports another: the links live in db.ts.
export const users = defineTable((c) => ({
  id: c.integer().primaryKey(),
  email: c.text().notNull().unique(),
  favorite_order_id: c.integer(),
}));

export const orders = defineTable((c) => ({
  id: c.integer().primaryKey(),
  user_id: c.integer().notNull(),
}));

export const categories = defineTable((c) => ({
  id: c.integer().primaryKey(),
  parent_id: c.integer(),
}));

export const shipments = defineTable(
  (c) => ({
    order_id: c.integer().notNull(),
    line: c.integer().notNull(),
  }),
  (t) => ({ primaryKey: [t.order_id, t.line] }),
);

export const shipment_events = defineTable((c) => ({
  id: c.integer().primaryKey(),
  order_id: c.integer().notNull(),
  line: c.integer().notNull(),
}));
