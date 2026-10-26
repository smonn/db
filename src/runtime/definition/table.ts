import type { Columns } from "./column.ts";
import type { ForeignKey } from "./foreign-keys.ts";
import type { TableIndex } from "./indexes.ts";
import type { DeclaredForeignKey } from "./references.ts";
import type { UniqueConstraint } from "./table-keys.ts";

/** A table without its name or schema, which `defineDatabase` gives it. */
export type TableDefinition<C extends Columns = Columns, K extends string = string> = {
  readonly columns: C;
  /** The primary key's columns in key order, empty without one. */
  readonly primaryKey: readonly K[];
  /** The primary key's constraint name when the Definition gives one; the catalog derives it otherwise. */
  readonly primaryKeyName: string | undefined;
  /** The unique constraints over two or more columns that the second callback declares. */
  readonly uniques: readonly UniqueConstraint[];
  /** The foreign keys the second callback declares; `defineDatabase` resolves them into `Table.foreignKeys`. */
  readonly declaredForeignKeys: readonly DeclaredForeignKey[];
  /** The indexes the second callback declares; a column's `.index()` stays in its state. */
  readonly indexes: readonly TableIndex[];
  /** The SQL name the table had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
};

export type Table<C extends Columns = Columns, K extends string = string> = TableDefinition<
  C,
  K
> & {
  readonly schema: string;
  readonly name: string;
  /** The foreign keys its columns and second callback declare, with each target's table named. */
  readonly foreignKeys: readonly ForeignKey[];
};
