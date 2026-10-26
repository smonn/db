import {
  catalogBuilder,
  type Catalog,
  type CatalogBuilder,
  type ColumnPayload,
  type DefaultPayload,
  type GeneratedPayload,
  type IdentityPayload,
} from "../catalog/index.ts";

type Column = {
  readonly type?: string;
  readonly notNull?: boolean;
  readonly default?: Omit<DefaultPayload, "volatile">;
  readonly identity?: IdentityPayload;
  readonly generated?: GeneratedPayload;
};

type Keys = {
  readonly primary?: readonly string[];
  readonly unique?: { readonly name: string; readonly column: string };
};

/** A `public.t` table with the given columns, each followed by its identity, generation, and default facts. */
export function table(columns: Readonly<Record<string, Column>>, keys: Keys = {}): Catalog {
  const builder: CatalogBuilder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const [name, column] of Object.entries(columns)) {
    const payload: ColumnPayload = {
      type: column.type ?? "text",
      notNull: column.notNull ?? false,
    };
    builder.column("public", "t", name, payload);
    addAttributes(builder, name, column);
  }
  if (keys.primary !== undefined) {
    builder.primaryKey("public", "t", "t_pkey", { columns: keys.primary });
  }
  if (keys.unique !== undefined)
    builder.unique("public", "t", keys.unique.name, {
      columns: [keys.unique.column],
      nullsNotDistinct: false,
    });
  return builder.build();
}

function addAttributes(builder: CatalogBuilder, name: string, column: Column): void {
  if (column.identity !== undefined) builder.columnIdentity("public", "t", name, column.identity);
  if (column.generated !== undefined) {
    builder.columnGenerated("public", "t", name, column.generated);
  }
  const { default: defaultPayload } = column;
  if (defaultPayload !== undefined) {
    builder.columnDefault("public", "t", name, { ...defaultPayload, volatile: false });
  }
}

export const always = { generated: "always" } as const;
export const byDefault = { generated: "by default" } as const;
