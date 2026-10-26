import type { ForeignKey, ForeignKeyAction, IndexMethod } from "../../runtime/definition/index.ts";

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

export type DomainPayload = {
  /** The base type as `format_type` renders it, such as `integer` or `public.mood`. */
  readonly base: string;
  /** Folds `typnotnull` and a Postgres 18 `pg_constraint` NOT NULL row, whatever its name. */
  readonly notNull: boolean;
  /** As `pg_get_expr` renders it, or null without one. */
  readonly default: string | null;
  /** True when the default calls a volatile function, as a column default's `volatile`. */
  readonly defaultVolatile: boolean;
};

/** A `NOT VALID` check is the same fact as a valid one. */
export type DomainCheckPayload = {
  /** What `CHECK` holds as `pg_get_constraintdef` renders it, such as `(VALUE > 0)`. */
  readonly expression: string;
};

export type PrimaryKeyPayload = {
  /** In key order, which is the order the index sorts by. */
  readonly columns: readonly string[];
};

export type UniquePayload = {
  /** In key order, which is the order the index sorts by. */
  readonly columns: readonly string[];
  readonly nullsNotDistinct: boolean;
};

/** One key of an index, in the order the index sorts by: a column, or an expression over columns. */
export type IndexKeyPayload = (
  | { readonly column: string }
  | {
      /** As Postgres deparses it, without the parentheses an index key needs around it. */
      readonly expression: string;
    }
) & {
  readonly descending: boolean;
  /** Postgres defaults to NULLs last for an ascending key and first for a descending one. */
  readonly nullsFirst: boolean;
};

export type IndexPayload = {
  readonly unique: boolean;
  readonly method: IndexMethod;
  readonly keys: readonly IndexKeyPayload[];
  /** Stored beside the keys, in the order given. */
  readonly include: readonly string[];
  /** The partial index's predicate as Postgres deparses it; `undefined` indexes every row. */
  readonly where: string | undefined;
  readonly nullsNotDistinct: boolean;
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

/** The columns an index names as plain keys; an expression key names none here. */
export function plainKeyColumns(keys: readonly IndexKeyPayload[]): string[] {
  return keys.flatMap((key) => ("column" in key ? [key.column] : []));
}
