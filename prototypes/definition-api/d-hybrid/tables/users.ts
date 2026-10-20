import { defineTable, type Row } from "../lib.ts";
import { createdAt } from "./columns.ts";

export const users = defineTable((c) => ({
  id: c.uuid().primaryKey().default(c.sql`gen_random_uuid()`),
  email: c.varchar(320).notNull().unique(),
  display_name: c.text(),
  age: c.smallint(),
  is_admin: c.boolean().notNull().default(false),
  ...createdAt(c),
}));

export type User = Row<typeof users>;
