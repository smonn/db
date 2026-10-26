export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export type ForeignKeyOptions = {
  /** Replaces the name Postgres would derive, `<table>_<column>_fkey`. */
  readonly name?: string;
  /** Defaults to `"no action"`. */
  readonly onDelete?: ForeignKeyAction;
  /** Defaults to `"no action"`. */
  readonly onUpdate?: ForeignKeyAction;
  /** Makes the constraint `DEFERRABLE` with this initial mode; without it the constraint is not deferrable. */
  readonly deferrable?: "immediate" | "deferred";
};

/** A column's foreign key before `defineDatabase` finds the table its target belongs to. */
export type ColumnReference = {
  /** A thunk, so tables in two files that import each other load in either order. */
  readonly target: () => Target<unknown>;
  readonly options: ForeignKeyOptions;
};

/** What a foreign key may point at: a primary key or unique column holding a `V`. */
export type Target<V> = {
  readonly state: { readonly primaryKey: boolean; readonly unique: boolean };
  readonly "~types": {
    readonly value: V;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
    readonly key: true;
  };
};
