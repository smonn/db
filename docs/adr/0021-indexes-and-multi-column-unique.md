---
status: proposed
---

# Indexes and multi-column unique in the second callback, with a small `.index()` on the column

The second callback gains `unique: [{ columns: [t.a, t.b] }]` for a unique constraint over two or more columns, and `indexes: [{ columns: [...] }]` for indexes, matching `primaryKey` and `foreignKeys` (ADR-0010, ADR-0019). A column also takes `.index()` or `.index({ name, method })`, so the common one-column index, such as on a foreign key column, reads like `.unique()`. `.index()` takes nothing more, to keep the API small until someone needs more.

## Considered Options

- **No `.index()` on the column**: SQL has no inline index and most indexes grow past one column, but the one-column case is common enough beside `.references()` to earn its own method.
- **`.index()` taking every `indexes` option**: one fewer reason to move an index to the second callback, but a larger API to keep stable before 1.0.
- **One `indexes` array for every unique, as `{ unique: true }`**: one place, but a unique constraint is what `ON CONFLICT ON CONSTRAINT` names and what can later be `DEFERRABLE`. A constraint costs nothing over its index, since Postgres backs it with the same unique btree.
- **Indexes over columns only, deferring expressions and `WHERE`**: a smaller first step, but diff compares two introspected databases (ADR-0013), so `pg_get_expr` normalizes an expression on both sides as it already does for defaults.

## Consequences

- An `indexes` entry takes `columns`, `where`, `include`, `method`, `unique`, `nullsNotDistinct`, and `name`. Each key in `columns` is a ref, an `sql` expression naming refs, or `{ key, order, nulls }` wrapping either. The field is called `columns`, like the other entries, though it can hold expressions.
- A `unique` entry takes `columns`, `name`, and `nullsNotDistinct`, and lists at least two columns; one column stays `.unique()`. A partial or expression unique goes in `indexes` with `unique: true`, since a constraint can hold neither.
- v0.2 models the method (btree, hash, gin, gist, brin), each key's order and nulls placement, expression keys, partial `WHERE`, `INCLUDE`, and `NULLS NOT DISTINCT`. `introspect` skips as Unmodeled (ADR-0005) an index with an opclass or collation other than the default, storage parameters, or a tablespace, as well as exclusion constraints and deferrable uniques. It also skips an index that backs a constraint, since the constraint is the fact.
- A unique constraint without a name takes Postgres's default, `<table>_<columns joined by _>_key`, and an index `<table>_<columns joined by _>_idx`. An index with an expression key must give its own `name`, since Postgres's `<table>_expr_idx` says nothing and collides. A longer name than 63 bytes throws instead of truncating. An index shares the schema's relation names, so it joins the clash check with tables, identity sequences, and key indexes, and two unnamed `.index()` calls on one column throw until one has a name.
- The `unique` fact's payload widens from `column` to `columns` and `nullsNotDistinct`. A new `index` fact sits under its table, named by the index, with `unique`, `method`, its keys (each a column or an expression, with `descending` and `nullsFirst`), `include`, `where`, and `nullsNotDistinct`. A changed payload drops the index and creates it again, since no `ALTER INDEX` changes any of these.
- Creating an index on a table that already exists holds `SHARE` on it, which blocks writes but not reads. That statement carries a new Hazard kind, `share_lock`, which joins the kinds `architecture.md` lists. An index on a table created in the same migration carries none. Dropping an index carries `access_exclusive_lock`. Lock Hazards get another look by 1.0.
- Generate never emits `CREATE INDEX CONCURRENTLY` (ADR-0020). When it does later, a unique constraint takes two steps: `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT ... UNIQUE USING INDEX`.
