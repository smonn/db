// The one Definition file the CLI loads, named in config. The keys name the
// schemas and tables.

import { defineDatabase } from "./lib.ts";
import { orders } from "./tables/orders.ts";
import { sessions } from "./tables/sessions.ts";
import { users } from "./tables/users.ts";

export default defineDatabase({
  public: { users, orders },
  auth: { sessions },
});
