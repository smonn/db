import { catalogBuilder, type Catalog, type ForeignKeyPayload } from "../catalog/index.ts";

export const PLAIN: ForeignKeyPayload = {
  columns: ["user_id"],
  target: { schema: "public", table: "users", columns: ["id"] },
  onDelete: "no action",
  onUpdate: "no action",
  match: "simple",
  deferrable: "not deferrable",
};

type Shape = {
  /** The tables `users` and `orders` exist unless this is false. */
  readonly orders?: boolean;
  readonly foreignKeys?: Readonly<Record<string, Partial<ForeignKeyPayload>>>;
  readonly users?: boolean;
};

/** `public.users (id)` and `public.orders (id, user_id)`, with the given foreign keys on `orders`. */
export function database({ orders = true, users = true, foreignKeys = {} }: Shape): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  if (users) addUsers(builder);
  if (orders) addOrders(builder, foreignKeys);
  return builder.build();
}

function addUsers(builder: ReturnType<typeof catalogBuilder>): void {
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: "integer", notNull: true });
  builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
}

function addOrders(
  builder: ReturnType<typeof catalogBuilder>,
  foreignKeys: NonNullable<Shape["foreignKeys"]>,
): void {
  builder.table("public", "orders");
  builder.column("public", "orders", "id", { type: "integer", notNull: true });
  builder.column("public", "orders", "user_id", { type: "integer", notNull: false });
  for (const [name, payload] of Object.entries(foreignKeys)) {
    builder.foreignKey("public", "orders", name, { ...PLAIN, ...payload });
  }
}

export const FK = "orders_user_id_fkey";
export const ADD: string = `alter table "public"."orders" add constraint "${FK}" foreign key ("user_id") references "public"."users" ("id")`;
export const DROP: string = `alter table "public"."orders" drop constraint "${FK}";`;
