import {
  catalogBuilder,
  type Catalog,
  type GeneratedPayload,
  type IndexKeyPayload,
  type IndexPayload,
} from "../catalog/index.ts";

/** A `public.t` table of text columns `a`, `b`, and `c`, with the named indexes. */
export function table(indexes: Readonly<Record<string, IndexPayload>>): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const name of ["a", "b", "c"]) {
    builder.column("public", "t", name, { type: "text", notNull: false });
  }
  for (const [name, payload] of Object.entries(indexes)) {
    builder.index("public", "t", name, payload);
  }
  return builder.build();
}

export const key = (
  column: string,
  descending: boolean = false,
  nullsFirst: boolean = descending,
): IndexKeyPayload => ({ column, descending, nullsFirst });

/** A btree index over `columns` with every other option at its default. */
export const plain = (...columns: string[]): IndexPayload => ({
  unique: false,
  method: "btree",
  keys: columns.map((column) => key(column)),
  include: [],
  where: undefined,
  nullsNotDistinct: false,
});

/** Integer columns `a` and `s`, where `s` takes each generation given, under the index `name`. */
export function withIndex(
  generated: readonly GeneratedPayload[],
  name: string,
  index: IndexPayload,
): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  builder.column("public", "t", "a", { type: "integer", notNull: false });
  builder.column("public", "t", "s", { type: "integer", notNull: false });
  for (const payload of generated) builder.columnGenerated("public", "t", "s", payload);
  builder.index("public", "t", name, index);
  return builder.build();
}
