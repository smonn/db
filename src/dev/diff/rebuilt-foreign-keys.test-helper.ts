import {
  catalogBuilder,
  type Catalog,
  type CatalogBuilder,
  type ForeignKeyPayload,
  type IndexPayload,
} from "../catalog/index.ts";
import { diff } from "./diff.ts";
import { FK, PLAIN } from "./foreign-keys.test-helper.ts";

export type Hook = (builder: CatalogBuilder) => void;

export type World = {
  readonly userId: string;
  readonly note: string;
  readonly foreignKeys: Readonly<Record<string, Partial<ForeignKeyPayload>>>;
  /** Runs after `users`, before `orders`. */
  readonly beforeOrders: Hook;
  /** Runs after the columns of `orders`, before its foreign keys. */
  readonly onOrders: Hook;
};

export const NOTHING: Hook = () => {};

const INDEX: IndexPayload = {
  unique: false,
  method: "btree",
  keys: [{ column: "note", descending: false, nullsFirst: false }],
  include: [],
  where: undefined,
  nullsNotDistinct: false,
};

/** `users (id)` with its primary key, and `orders (user_id, note)` with the given foreign keys. */
export function world(changes: Partial<World> = {}): Catalog {
  const { userId, note, foreignKeys, beforeOrders, onOrders }: World = {
    userId: "integer",
    note: "text",
    foreignKeys: { [FK]: {} },
    beforeOrders: NOTHING,
    onOrders: NOTHING,
    ...changes,
  };
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: "integer", notNull: true });
  builder.primaryKey("public", "users", "users_pkey", { columns: ["id"] });
  beforeOrders(builder);
  builder.table("public", "orders");
  builder.column("public", "orders", "user_id", { type: userId, notNull: false });
  builder.column("public", "orders", "note", { type: note, notNull: false });
  onOrders(builder);
  for (const [name, payload] of Object.entries(foreignKeys)) {
    builder.foreignKey("public", "orders", name, { ...PLAIN, ...payload });
  }
  return builder.build();
}

/** The statements of the diff, each without its hazard comments. */
export function statements(from: Catalog, to: Catalog): string[] {
  return diff(from, to)
    .sql.split("\n\n")
    .map((statement) => statement.replaceAll(/^-- hazard: \w+\n/gmu, "").trim());
}

export const drop = (name: string): string =>
  `alter table "public"."orders" drop constraint "${name}";`;

export const add = (name: string): string =>
  `alter table "public"."orders" add constraint "${name}" foreign key ("user_id")`;

/** A table `invoices (user_id)`, with a foreign key under `name` when it has one, ahead of `orders`. */
export const invoices =
  (name?: string): Hook =>
  (builder) => {
    builder.table("public", "invoices");
    builder.column("public", "invoices", "user_id", { type: "integer", notNull: false });
    if (name !== undefined) builder.foreignKey("public", "invoices", name, PLAIN);
  };

/** An index of `orders` that shares the name of a foreign key. */
export const indexNamed =
  (name: string): Hook =>
  (builder) => {
    builder.index("public", "orders", name, INDEX);
  };
