import { defineDatabase } from "./lib.ts";
import { categories, orders, shipment_events, shipments, users } from "./tables.ts";

export default defineDatabase(
  { public: { users, orders, categories, shipments, shipment_events } },
  ({ public: db }) => ({
    foreignKeys: [
      { columns: [db.users.favorite_order_id], references: [db.orders.id], onDelete: "set null" },
      { columns: [db.orders.user_id], references: [db.users.id], onDelete: "cascade" },
      { columns: [db.categories.parent_id], references: [db.categories.id] },
      {
        columns: [db.shipment_events.order_id, db.shipment_events.line],
        references: [db.shipments.order_id, db.shipments.line],
        match: "full",
        deferrable: "deferred",
      },
    ],
  }),
);
