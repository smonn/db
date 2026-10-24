import { defineDatabase, defineTable } from "./lib.ts";
import { orders } from "./tables/orders.ts";
import { users } from "./tables/users.ts";

const categories = defineTable(
  (c) => ({
    id: c.integer().primaryKey(),
    parent_id: c.integer(),
  }),
  (t) => ({ foreignKeys: [{ columns: [t.parent_id], references: [t.id] }] }),
);

const shipments = defineTable(
  (c) => ({
    order_id: c.integer().notNull(),
    line: c.integer().notNull(),
  }),
  (t) => ({ primaryKey: [t.order_id, t.line] }),
);

const shipment_events = defineTable(
  (c) => ({
    id: c.integer().primaryKey(),
    order_id: c.integer().notNull(),
    line: c.integer().notNull(),
  }),
  (t) => ({
    foreignKeys: [
      {
        columns: [t.order_id, t.line],
        references: () => [shipments.columns.order_id, shipments.columns.line],
        match: "full",
        deferrable: "deferred",
      },
    ],
  }),
);

export default defineDatabase({
  public: { users, orders, categories, shipments, shipment_events },
});
