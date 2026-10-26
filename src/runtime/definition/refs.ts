import type { Columns } from "./column.ts";

/**
 * A reference to column `K` of the table with columns `C`, which table-level entries name instead of
 * a string. `"~table"` exists only in types; its function type holds `C` invariant, so a reference
 * from a table with other columns fails to compile.
 */
export type Ref<K extends string = string, C extends Columns = Columns> = {
  readonly "~ref": K;
  readonly "~table": (columns: C) => C;
};

/** The column references handed to a table's second callback, one per column key. */
export type ColumnRefs<C extends Columns> = { readonly [K in keyof C & string]: Ref<K, C> };

export type OwnRef<C extends Columns> = Ref<keyof C & string, C>;
