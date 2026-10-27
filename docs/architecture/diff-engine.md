# Diff engine

How generate turns the Definition into the Current migration. ADR-0005 and ADR-0013 give the reasons; the rest is v0.1 design that can change without an ADR.

## What v0.1 models

Schemas, tables, columns (type, NOT NULL, default, identity), single and composite primary keys, unique constraints over one or more columns and indexes over columns (ADR-0021), foreign keys (ADR-0019), and enums and domains (ADR-0023): exactly what the Definition can express.

Both introspections skip the Tracking schema (`smonn_db` unless configured), `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`, extension members, and every kind outside this list (ADR-0005). Generate refuses a Definition that names one of these schemas, since its tables would vanish from the diff.

## Pipeline

1. The Definition converts to a catalog, spelling each type as `format_type` does, and the diff renders it against the catalog of the freshly created Definition database, which holds only template0's `public` schema. That SQL builds the Definition database. The catalog, renames, and the skipped-schema check read the Definition by SQL names, through the view `defineDatabase` keeps after mapping keys with its casing and explicit names (ADR-0024), so every derived name comes from SQL names.
2. `introspect` reads each database in one `REPEATABLE READ READ ONLY` transaction with `search_path` pinned to `pg_catalog`, keyed by name, never by OID.
3. Generate runs the Definition's `renamedFrom` markers on the Shadow inside a transaction, introspects it, and rolls back (ADR-0024). Postgres follows a rename by OID, so every default and expression in that catalog already names the new object. A marker whose old name the Shadow lacks is skipped, and one whose old and new names both exist throws.
4. `diff` compares the two catalogs, turns the differences into actions, orders them, and emits SQL. The renames that ran open the SQL, so the migration repeats them. It also returns hints, which generate prints but never writes into the SQL: the `renamedFrom` to add when a column or table looks dropped and added, and the `renamedLabels` entry to add when an enum removes one label and adds one at the same position (`diff/hints.ts`).
5. For generated SQL, generate scans the Shadow's `pg_depend` from what the actions drop or retype, with the renames and each enum swap's rename aside run, and stops naming every Unmodeled blocker (ADR-0025). `diff/scans.ts` gives each action kind its walk, so a new kind fails to compile until it names one. A hand edit skips the scan.
6. Generate verifies the SQL, or a [hand edit](cli.md#hand-edits), in the Shadow (ADR-0013), then writes the Current migration.

## Catalog

A flat `Map<key, fact>`. A key is the chain of names from the schema down (`public`, `users`, `email`), joined with `\0`, which no Postgres name can hold, so a table named `users.email` keys apart from the column `email` on `users`. Only the catalog module builds keys; `definitionCatalog` and `introspect` add facts through its builder.

Each fact carries its parent's key and a plain-data payload compared by deep equality. A default, a primary key, and a unique constraint are separate facts, so one changed default is one difference. Payloads leave out the fact's own name, so a renamed fact can match by payload.

### Columns

A column's type is the spelling `format_type` gives (`character varying(20)`, `timestamp with time zone`), so `definitionCatalog` rewrites the Definition's `varchar(20)` and `timestamptz` to match what `introspect` reads. An array column (ADR-0023) adds `[]` to its element's spelling; `introspect` skips arrays of composite or range types as Unmodeled. NOT NULL is a column attribute; Postgres 18's `pg_constraint` NOT NULL rows are folded into it through `attnotnull`, so a constraint's name never reaches the catalog.

A default is a child fact named `default` whose payload is the expression as `pg_get_expr` renders it and whether it calls a volatile function. An identity is a child fact named `identity` whose payload is `always` or `by default` and the name of its sequence, which a table or column rename leaves behind (`introspect` reads it through `pg_depend`); its sequence options are not modeled. A generated column carries neither: its child fact `generated` holds the expression as `pg_get_expr` renders it and its storage (`stored` or `virtual`). The Definition cannot express generated columns yet, so only `introspect` builds one.

### Primary keys and unique constraints

Each is a child fact of the table, named by its constraint, since a drop must say which one; a rename is a drop and an add, which `diff/renames.ts` pairs (see SQL rules). The key puts an empty segment before the name (`public\0users\0\0users_pkey`), which no Postgres name can be, so a constraint never keys like a column of the same name. A primary key's payload lists its columns in key order; a unique constraint's also says whether it is `NULLS NOT DISTINCT`. Postgres makes primary key columns NOT NULL, so a catalog that names a primary key marks them NOT NULL, as `introspect` reads them.

`definitionCatalog` takes the name the Definition gives a key (`.primaryKey({ name })`, `.unique({ name })`, `{ name, columns }`, a `unique` entry's `name`) or derives Postgres's default (`users_pkey`, `users_email_key`, and `<table>_<columns joined by _>_key` for a multi-column unique). It refuses a name over 63 bytes, which Postgres would truncate, and two keys in one schema that take one name, since each key's index shares the schema's relation names. Only the second callback's `unique` entry declares a multi-column unique, with at least two columns of its own table, in key order, plus `name` and `nullsNotDistinct`.

`introspect` reads a unique constraint over any number of columns, with its `NULLS NOT DISTINCT` setting. It skips as Unmodeled (ADR-0005) a key that is `DEFERRABLE`, has `INCLUDE` columns, or (primary key) `WITHOUT OVERLAPS`, and a single-column `NULLS NOT DISTINCT` unique, which no Definition can declare (a `unique` entry needs two columns): each reads like a plain key but changes what the key means. A changed column list or setting is a drop and an add.

### Indexes

An index is a child fact of its table, named by the index and keyed like a key. Its payload holds `unique`, `method`, its keys in order (a column, or an expression, with `descending` and `nullsFirst`), `include`, `where`, and `nullsNotDistinct`. A changed payload drops and creates it again, since no `ALTER INDEX` changes any of these. An unnamed index takes `<table>_<columns joined by _>_idx`; one with an expression key must give its name. `definitionCatalog` refuses a name over 63 bytes and one another relation of the schema holds (a table, sequence, key, or index), as two unnamed `.index()` calls on a column do. An index and a foreign key may share a name.

An expression key or `where` is an `sql` expression whose interpolated references render as quoted columns and whose other values throw, since DDL binds nothing. The Definition keeps its text as written. `introspect` reads each expression key with `pg_get_indexdef(index, key, true)`, minus the parentheses it adds, and the predicate with `pg_get_expr`, so the Shadow's deparse normalizes spacing and casts as it does for defaults. The payload does not track the columns an expression names, so a rebuilt column does not rebuild an index that names it only in an expression.

`introspect` skips as Unmodeled (ADR-0005) an index with a method but btree, hash, gin, gist, or brin, an opclass or collation other than the default, storage parameters, a tablespace, an invalid one (a failed `CREATE INDEX CONCURRENTLY`), and an index that backs a primary key, unique, or exclusion constraint, since the constraint is the fact.

### Foreign keys

A foreign key is a child fact of its table, named by its constraint and keyed like a key. Its payload holds its columns, the target's schema, table, and columns (paired by position), `onDelete`, `onUpdate`, `match`, and `deferrable`. A changed payload drops the constraint and adds it back. A `NOT VALID` foreign key is the same fact as a valid one.

`defineDatabase` resolves each target column to its table by identity, so the catalog reads names only; the builder checks the target at `build`, since a target may come after the foreign key. A column's `.references()` and a `foreignKeys` entry in the second callback yield the same fact. The name is the one the Definition gives, or Postgres's default, `<table>_<columns joined by _>_fkey`. `definitionCatalog` refuses a name over 63 bytes, and two constraints on one table that take one name.

`introspect` skips as Unmodeled a foreign key that is `NOT ENFORCED`, uses `PERIOD`, names a column list on `SET NULL` or `SET DEFAULT`, or points at an Unmodeled table, such as a partitioned one or one in a skipped schema.

### Enums

An enum is a fact under its schema, keyed like a table (a type and a table share one pool of names), whose payload lists its labels in sort order. A column of an enum names it as `format_type` spells it under `search_path = pg_catalog` (`public.mood`). `introspect` reads labels by `enumsortorder` and skips an enum an extension owns as Unmodeled.

`definitionCatalog` names an enum or domain by its SQL name and finds it from a column by identity. It refuses a label that is empty, repeated, or over 63 bytes, a type rolled up under two names, and a column whose type is not in the Definition.

A label added to an existing enum is one `ALTER TYPE ... ADD VALUE ... BEFORE|AFTER` at its declared position, with no Hazard. Using a new label in the same migration fails (`55P04`); `shadow-errors.ts` words the fix.

A `renamedLabels` entry renames a label in place with `ALTER TYPE ... RENAME VALUE`, which keeps its position and locks no table, so it avoids the swap below.

A removed or reordered label swaps the type (ADR-0023): phase 1 renames the old one aside, phase 5 creates the new one, phase 6 retypes each column of it or its array with `USING col::text::<type>`, dropping and setting its default around it, and phase 8 drops the old one. The diff refuses a swap while a domain fact in the catalog depends on the enum, naming the domain. It also refuses when a column of the enum or its array is stored generated in both catalogs, since Postgres rejects `USING` on a generated column, naming the column; one the Definition makes plain loses its expression first.

A created enum lists all its labels, so a swap that also adds one has no `ADD VALUE`.

### Domains

A domain is a fact under its schema, keyed like an enum. Its payload holds its base as `format_type` spells it, its default as `pg_get_expr` renders it and whether that calls a volatile function, and NOT NULL, folded like a column's. Each check is a child `domain check` fact named by its constraint; a `NOT VALID` one is the same fact. `introspect` skips as Unmodeled a domain over a domain or array, or with its own collation. Generate refuses a changed base, and a name switching between enum and domain.

## Ordering

Each action is one statement-sized change, such as create table, add column, or set default. One `order(actions)` function sorts them into fixed phases (#381). A phase table in `diff/phases.ts` gives each action kind its phase and its rank within the phase, so a new kind fails to compile until it names one. Phase _n_ is the _n_th entry of `PHASES`. The phases, with the kinds each will hold once v0.2 lands:

1. `RENAME` of tables, columns, enums, domains, labels, and an enum type swap's old type.
2. Payload-matched renames of constraints, indexes, sequences, and domain checks, which compare under the names phase 1 gives.
3. Drop foreign key, index, unique constraint, primary key.
4. Drop column, then table.
5. Create or alter schema or type: create schema, enum; enum `ADD VALUE`; create domain, after the labels it may use; domain alters and checks. All before columns, so a new column gets the new domain default.
6. Create table, add column, then column alters: drop default, drop identity or expression, type (an enum swap's retypes included), NOT NULL, set default or expression, add identity or switch identity mode.
7. Add primary key, unique constraint, index, foreign key.
8. Drop domain, then enum, after the retypes.
9. Drop schema, last so a type drop precedes it.

Ranks leave gaps, so a new kind never renumbers another. Within a rank, ties keep catalog order, which `introspect` sorts by name for schemas, tables, and constraints and by position for columns, so new columns follow the Definition. Drops, including the drop half of a changed key, follow the source catalog, and everything else the target catalog.

Dropping a table or column drops what it holds, so no separate drop is emitted for its children, except a foreign key, which always gets its own `DROP CONSTRAINT`. A schema drop without `CASCADE` refuses while the schema holds anything, so each of its tables drops first, without its children. Keys drop in phase 3 and add in phase 7, so a changed key is rebuilt around the column changes it spans.

## SQL rules

- Never `CASCADE` (ADR-0013).
- A default renders in parentheses (`default (now())`), so any expression the Definition writes parses.
- A generation expression renders inline in `CREATE TABLE` and `ADD COLUMN`, changes with `SET EXPRESSION`, and drops with `DROP EXPRESSION` from a stored column. Any other change to it drops the column and adds it back (appended, with its keys), which carries `data_loss`.
- A column's identity is added or dropped, or switched between `always` and `by default` with `ALTER COLUMN ... SET GENERATED`. Sequence options are not modeled.
- Primary keys and unique constraints drop with `ALTER TABLE ... DROP CONSTRAINT` in phase 3 and add with `ALTER TABLE ... ADD CONSTRAINT` in phase 7, never inline in `CREATE TABLE`, which also silently drops an inline unique that duplicates the primary key.
- Indexes drop with `DROP INDEX` in phase 3 and add with `CREATE INDEX` in phase 7, never `CONCURRENTLY` (ADR-0020). The statement leaves out the clauses at Postgres's defaults (`btree`, the order and NULLs placement a key sorts by). An expression key renders in its own parentheses, and `where` comes last.
- Foreign keys add with `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` in phase 7 after the tables and keys they need, never inline, so self references and cycles work. The statement leaves out the clauses at Postgres's defaults (`NO ACTION`, `MATCH SIMPLE`, not deferrable). Each drops with its own `DROP CONSTRAINT` in phase 3 before the keys it needs, even under a dropped table, since its target table may drop first.
- A new column appends; column order differences are ignored, since Postgres can't reorder columns.
- A type change is a plain `ALTER COLUMN ... TYPE` with no `USING`, except an enum swap's retype. When a cast is needed, edit the Current migration by hand.
- A table or column with a `renamedFrom` marker renames with `ALTER TABLE ... RENAME TO` or `ALTER TABLE ... RENAME COLUMN` in phase 1, tables first, so the column statements and every later statement use the new names. A rename combined with a retype emits the `RENAME` first. Without a marker, a renamed key drops and creates, flagged as data loss (ADR-0010, ADR-0024).
- A primary key, unique constraint, foreign key, or index whose name changes, as a table or column rename changes every derived name, renames in place in phase 2 with no Hazard: `ALTER TABLE ... RENAME CONSTRAINT`, or `ALTER INDEX ... RENAME TO`. Under one table, a dropped and an added fact of one kind with the same payload pair up; two candidates on either side, or a new name that a dropped fact still holds, stay a drop and an add (`diff/renames.ts`). An identity whose sequence name changed renames it with `ALTER SEQUENCE ... RENAME TO` in the same phase, since each column has one identity and so one candidate.
- An enum or domain with `renamedFrom` renames with `ALTER TYPE ... RENAME TO` or `ALTER DOMAIN ... RENAME TO`, and an enum's `renamedLabels` entries with `ALTER TYPE ... RENAME VALUE`, keyed new to old. They run in phase 1 after the table and column renames, enum before labels, and the label statement names the enum as renamed. A domain check whose expression matches a dropped one under the same domain renames with `ALTER DOMAIN ... RENAME CONSTRAINT` in phase 2 and no Hazard; two candidates on either side stay a drop and an add (`diff/renames.ts`).

## Hazards

Each action kind declares its Hazards (`data_loss`, `rewrite`, `access_exclusive_lock`, `share_lock`, `share_row_exclusive_lock`, `rename`) in a table, classified from the catalog, not the SQL text. Each Hazard is written as a `-- hazard: <kind>` comment above its statement, and generate returns them with their statements. Generation never blocks on a Hazard; commit does, per kind (ADR-0015). Commit also refuses a near-miss `-- hazard:` comment (indented, unspaced, recased, trailing, or mid-statement), since that would drop its gate by accident.

- `data_loss`: a dropped column or table (so a rename too, ADR-0010, unless a `renamedFrom` marker declares it, which carries `rename` instead, ADR-0024), and a type change that converts values without an error but not back, such as `numeric(10,2)` to `integer`, `timestamptz` to `date`, or `double precision` to `real`. A change that fails on a value that doesn't fit, such as `bigint` to `integer`, loses nothing, since the statement rolls back. An enum swap's retypes carry it when a label is removed (ADR-0023).
- `rewrite`: a type change Postgres can't make in place (text to an enum, an enum to text, and one enum to another among them), and a new column whose default calls a volatile function, that is an identity, is stored generated, is of a constrained domain, or takes its domain's volatile default, and a new expression on a stored generated column, because each row needs its own value. A virtual column computes on read and rewrites nothing.
  - `retypeHazards` in `diff/hazards.ts` lists the type changes Postgres makes in place, and how an array's element type counts.
  - A default is volatile when its expression calls a function that `pg_proc` marks volatile, which `introspect` reads by function name, since `pg_depend` omits built-in functions.
- `access_exclusive_lock`: a statement that holds the lock while it does work that grows with the table. Every `ALTER TABLE` takes that lock, but only a rewrite (which therefore carries both kinds), `SET NOT NULL` (a scan of every row), and adding a primary key or unique constraint (an index build) hold it past a catalog change. Adding a key to a table created in the same migration is empty, so it carries nothing.
- `share_lock`: creating an index on a table that already exists. The build holds `SHARE` on the table, which blocks writes but not reads. An index on a table created in the same migration carries nothing, and dropping one carries none, since it only changes the catalog. A domain's `SET NOT NULL` or new check scans its columns under `SHARE` too.
- `share_row_exclusive_lock`: adding a foreign key to a table that already exists. The statement scans the table while it holds `SHARE ROW EXCLUSIVE` on it and on the table it points at, which blocks writes but not reads. A foreign key on a table created in the same migration carries nothing. Generate doesn't split the add into `NOT VALID` then `VALIDATE CONSTRAINT` (ADR-0020), since the split only helps when the two commit separately.
- `rename`: a table, column, enum, label, or domain rename (a domain check's has none). The statement only changes the catalog, but app code still on the old name breaks between `migrate` and its deploy, so accepting it should be explicit (ADR-0024).

A type v0.1 doesn't classify carries every Hazard, since only the gate can say it is safe.

## Postgres versions

v0.1 supports Postgres 18 and newer, and CI runs 18 and, once released, 19. `generate` and `reset` refuse an older server with an error naming the minimum. `generate` hits the check in `withShadowDatabases` and `introspect`, which read `server_version_num`; `reset` checks before it drops or replays anything. `introspect` branches in TypeScript when a catalog differs between versions.
