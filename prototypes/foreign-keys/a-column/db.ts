import { defineDatabase } from "./lib.ts";
import { orders } from "./tables/orders.ts";
import { users } from "./tables/users.ts";

// A can't express the self reference or the composite key the other variants add: see checks.ts.
export default defineDatabase({ public: { users, orders } });
