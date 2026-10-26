import type { ForeignKey, ForeignKeyAction } from "../../runtime/definition/index.ts";

export type ColumnPayload = {
  /** The type as `format_type` renders it, such as `character varying(20)`. */
  readonly type: string;
  /** True for a Postgres 18 `pg_constraint` NOT NULL row too, whatever its constraint name. */
  readonly notNull: boolean;
};

export type DefaultPayload = {
  /** The expression as `pg_get_expr` renders it, such as `now()` or `'new'::text`. */
  readonly expression: string;
  /**
   * True when the expression calls a volatile function, such as `random()` or `nextval`, so
   * adding the column evaluates it once per row instead of once for the table.
   */
  readonly volatile: boolean;
};

export type IdentityPayload = {
  readonly generated: "always" | "by default";
};

export type GeneratedPayload = {
  /** The expression as `pg_get_expr` renders it, such as `(a * 2)`. */
  readonly expression: string;
  /** Postgres 18 defaults to `virtual`; only `stored` keeps its values on disk. */
  readonly storage: "stored" | "virtual";
};

/** Labels in sort order, which is the order the enum compares in. */
export type EnumPayload = { readonly labels: readonly string[] };

export type PrimaryKeyPayload = {
  /** In key order, which is the order the index sorts by. */
  readonly columns: readonly string[];
};

export type UniquePayload = {
  readonly column: string;
};

export type ForeignKeyPayload = {
  /** In key order, pairing with the target's columns by position. */
  readonly columns: readonly string[];
  readonly target: {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
  };
  readonly onDelete: ForeignKeyAction;
  readonly onUpdate: ForeignKeyAction;
  readonly match: ForeignKey["match"];
  readonly deferrable: ForeignKey["deferrable"];
};
