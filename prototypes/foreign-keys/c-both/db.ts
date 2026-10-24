import { orders } from "../a-column/tables/orders.ts";
import { users } from "../a-column/tables/users.ts";
import b from "../b-table/db.ts";
import { defineDatabase } from "./lib.ts";

// C is A for a single column pointing at another table, and B for the rest: a self reference can't
// go on the column without a type annotation, and a composite key needs the second callback.
const { categories, shipments, shipment_events } = b.schemas.public;

export default defineDatabase({
  public: { users, orders, categories, shipments, shipment_events },
});
