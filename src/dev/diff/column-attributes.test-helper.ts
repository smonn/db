import {
  catalogBuilder,
  type Catalog,
  type CatalogBuilder,
  type ColumnPayload,
  type DefaultPayload,
  type IdentityPayload,
} from "../catalog/index.ts";

type Column = {
  readonly type?: string;
  readonly notNull?: boolean;
  readonly default?: Omit<DefaultPayload, "volatile">;
  readonly identity?: IdentityPayload;
};

/** A `public.t` table with the given columns, each followed by its default and identity facts. */
export function table(columns: Readonly<Record<string, Column>>): Catalog {
  const builder: CatalogBuilder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const [name, column] of Object.entries(columns)) {
    const payload: ColumnPayload = {
      type: column.type ?? "text",
      notNull: column.notNull ?? false,
    };
    builder.column("public", "t", name, payload);
    if (column.identity !== undefined) builder.columnIdentity("public", "t", name, column.identity);
    const { default: defaultPayload } = column;
    if (defaultPayload !== undefined) {
      builder.columnDefault("public", "t", name, { ...defaultPayload, volatile: false });
    }
  }
  return builder.build();
}

export const always = { generated: "always" } as const;
export const byDefault = { generated: "by default" } as const;
