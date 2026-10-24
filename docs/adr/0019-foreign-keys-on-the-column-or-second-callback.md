---
status: accepted
---

# Foreign keys on the column, or in the second callback for composite and self references

A foreign key from one column to another table's key goes on the column: `user_id: c.integer().notNull().references(() => users.columns.id, { onDelete: "cascade" })`. A composite foreign key, or one that points at its own table, goes in the second callback: `foreignKeys: [{ columns: [t.parent_id], references: [t.id] }]`. This follows ADR-0010's primary key rule, where one column goes on the column and a composite key in the second callback, and the common case reads like SQL's `user_id integer references users (id)`.

## Considered Options

The [prototype](https://github.com/smonn/db/tree/prototype/foreign-keys/prototypes/foreign-keys) compared these shapes.

- **Every foreign key in the second callback**: one place and one form, but a wrong target fails with a 10-line chain on the whole callback instead of three lines at the target.
- **Foreign keys in a second callback of `defineDatabase`**: the tables are values by then, so it needs no thunks and no annotations, even in a cycle. But it follows neither the primary key rule nor the SQL a column's `references` reads like.
- **Only `.references()` on the column**: it can't express a composite foreign key, and every self reference needs a type annotation.

## Consequences

- A self reference breaks the primary key rule: it goes in the second callback even for one column, so a `foreignKeys` entry may list a single column where a `primaryKey` entry may not. On the column it would need the type annotation below, and the table's own refs need none.
- `foreignKeys` is an array, not one entry like `primaryKey`, since a table can hold many foreign keys. Each entry takes `name`, `onDelete`, `onUpdate`, `match`, and `deferrable`; `.references()` takes the same options except `match`, which only matters for several columns.
- `.references()` takes a thunk, so tables in two files that import each other load in either order.
- When two tables point at each other, TypeScript can't infer either table's type (TS7022) until one thunk in the cycle names its return type: `.references((): Target<number> => orders.columns.id)`. A self reference avoids this by naming the table's own refs in the second callback. The exported `Target<V>` type still checks the value type, where Drizzle's `AnyPgColumn` doesn't.
- The types check that each column pair holds the same TypeScript value, that a one-column target is a primary key or unique column, and that the column counts match. A `bigint` column can't point at an `integer` key, although Postgres allows it.
- `defineDatabase` is the first point where every table has a name, so it finds each target's table by the identity of its column value. It refuses a target table outside the Database, a target table rolled up under two names, and a composite target that isn't the table's primary key, naming both tables in each error.
- `Ref`'s `"~table"` brand stays invariant: a foreign target is another table's column value of type `Target<V>`, not a ref. The Definition's `Refs` type is renamed `ColumnRefs`, so `Refs` names only the query layer's type. `ColumnState` gets its own `references` slot, apart from the key's `constraintName`.
- A foreign key is a `foreign key` fact under its table, named by its constraint like the keys. Its payload holds the columns, the target's schema, table, and columns, `onDelete`, `onUpdate`, `match`, and `deferrable`. A changed payload drops the constraint and adds it back.
- A foreign key without a name of its own takes Postgres's default, `<table>_<columns joined by _>_fkey`. The 63-byte rule applies. A foreign key creates no index, so its name clashes only with another constraint on the same table.
- Generate adds every foreign key with `ALTER TABLE ... ADD CONSTRAINT` after the tables and keys it needs exist, never inline in `CREATE TABLE`, so self references and cycles work. It drops one before anything it depends on.
- Adding a foreign key to a table that already exists scans it while holding `SHARE ROW EXCLUSIVE` on both tables, which blocks writes but not reads. That statement carries a new Hazard kind, `share_row_exclusive_lock`, which joins the kinds `architecture.md` lists. A foreign key on a table created in the same migration carries none. Splitting the add into `NOT VALID` then `VALIDATE CONSTRAINT` waits on the decision about migrations that run outside a transaction ([#375](https://github.com/smonn/db/issues/375)), since both statements in one transaction hold the stronger lock until commit.
- `introspect` skips as Unmodeled (ADR-0005) a foreign key that is `NOT ENFORCED`, uses `PERIOD`, has a column list on `SET NULL` or `SET DEFAULT`, or points at an Unmodeled table. A `NOT VALID` foreign key is the same fact as a valid one. Whether diff should emit `VALIDATE CONSTRAINT` for it is decided with #375.
