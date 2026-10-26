# Diff engine

How generate turns the Definition into the Current migration. ADR-0005 and ADR-0013 give the reasons; the rest is v0.1 design that can change without an ADR.

## What v0.1 models

Schemas, tables, columns (type, NOT NULL, default, identity), single and composite primary keys, unique constraints over one or more columns (ADR-0021), one-column foreign keys (ADR-0019), and enums (ADR-0023): exactly what the Definition can express. Indexes wait for v0.2.

Both introspections skip the Tracking schema (`smonn_db` unless configured), `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`, extension members, and every kind outside this list (ADR-0005). Generate refuses a Definition that names one of these schemas, since its tables would vanish from the diff.

## Pipeline

1. The Definition converts to a catalog, spelling each type as `format_type` does, and the diff renders it against the catalog of the freshly created Definition database, which holds only template0's `public` schema. That SQL builds the Definition database.
2. `introspect` reads each database in one `REPEATABLE READ READ ONLY` transaction with `search_path` pinned to `pg_catalog`, keyed by name, never by OID.
3. Generate runs the Definition's `renamedFrom` markers on the Shadow inside a transaction, introspects it, and rolls back (ADR-0024). Postgres follows a rename by OID, so every default and expression in that catalog already names the new object. A marker whose old name the Shadow lacks is skipped, and one whose old and new names both exist throws.
4. `diff` compares the two catalogs, turns the differences into actions, orders them, and emits SQL. The renames that ran open the SQL, so the migration repeats them. It also returns hints, which generate prints: the `renamedFrom` to add when a table drops one column and adds one of the same type, or a schema drops one table and adds one with identical columns. A hint never reaches the SQL.
5. Generate verifies the SQL, or a [hand edit](cli.md#hand-edits), in the Shadow (ADR-0013), then writes the Current migration.

## Catalog

A flat `Map<key, fact>`. A key is the chain of names from the schema down (`public`, `users`, `email`), joined with `\0`, which no Postgres name can hold, so a table named `users.email` keys apart from the column `email` on `users`. Only the catalog module builds keys: `definitionCatalog` and `introspect` add facts through its builder, and `diff` finds parents, children, and names through its lookups.

Each fact carries its parent's key and a plain-data payload compared by deep equality. A default, a primary key, and a unique constraint are separate facts, so one changed default is one difference. Payloads leave out the fact's own name, so a renamed fact can match by payload.

### Columns

A column's type is the spelling `format_type` gives (`character varying(20)`, `timestamp with time zone`), so `definitionCatalog` rewrites the Definition's `varchar(20)` and `timestamptz` to match what `introspect` reads. An array column (ADR-0023) adds `[]` to its element's spelling; `introspect` skips arrays of composite or range types as Unmodeled. NOT NULL is a column attribute; Postgres 18's `pg_constraint` NOT NULL rows are folded into it through `attnotnull`, so a constraint's name never reaches the catalog.

A default is a child fact named `default` whose payload is the expression as `pg_get_expr` renders it and whether it calls a volatile function. An identity is a child fact named `identity` whose payload is `always` or `by default`; its sequence options are not modeled. A generated column carries neither: its child fact `generated` holds the expression as `pg_get_expr` renders it and its storage (`stored` or `virtual`). The Definition cannot express generated columns yet, so only `introspect` builds one.

### Primary keys and unique constraints

Each is a child fact of the table, named by its constraint, since a drop must say which one; a rename is a drop and an add. The key puts an empty segment before the name (`public\0users\0\0users_pkey`), which no Postgres name can be, so a constraint never keys like a column of the same name. A primary key's payload lists its columns in key order; a unique constraint's also says whether it is `NULLS NOT DISTINCT`. Postgres makes primary key columns NOT NULL, so a catalog that names a primary key marks them NOT NULL, as `introspect` reads them.

`definitionCatalog` takes the name the Definition gives a key (`.primaryKey({ name })`, `.unique({ name })`, `{ name, columns }`, a `unique` entry's `name`) or derives Postgres's default (`users_pkey`, `users_email_key`, and `<table>_<columns joined by _>_key` for a multi-column unique). It refuses a name over 63 bytes, which Postgres would truncate, and two keys in one schema that take one name, since each key's index shares the schema's relation names. Only the second callback's `unique` entry declares a multi-column unique, with at least two columns of its own table, in key order, plus `name` and `nullsNotDistinct`.

`introspect` reads a unique constraint over any number of columns, with its `NULLS NOT DISTINCT` setting. It skips as Unmodeled (ADR-0005) a key that is `DEFERRABLE`, has `INCLUDE` columns, or (primary key) `WITHOUT OVERLAPS`, and a single-column `NULLS NOT DISTINCT` unique, which no Definition can declare (a `unique` entry needs two columns): each reads like a plain key but changes what the key means. A changed column list or setting is a drop and an add.

### Foreign keys

A foreign key is a child fact of its table, named by its constraint and keyed like a key. Its payload holds its columns, the target's schema, table, and columns (paired by position), `onDelete`, `onUpdate`, `match`, and `deferrable` (`not deferrable`, `immediate`, or `deferred`). A changed payload drops the constraint and adds it back. A `NOT VALID` foreign key is the same fact as a valid one.

`defineDatabase` resolves each target column to its table by identity, so the catalog reads names only; the builder checks the target at `build`, since a target may come after the foreign key. The name is the one `.references(target, { name })` gives, or Postgres's default, `<table>_<columns joined by _>_fkey`. `definitionCatalog` refuses a name over 63 bytes, and two constraints on one table that take one name; a foreign key has no index, so it clashes with nothing else.

`introspect` skips as Unmodeled a foreign key that is `NOT ENFORCED`, uses `PERIOD`, names a column list on `SET NULL` or `SET DEFAULT`, or points at an Unmodeled table, such as a partitioned one or one in a skipped schema.

### Enums

An enum is a fact under its schema, keyed like a table (a type and a table share one pool of names), whose payload lists its labels in sort order. A column of an enum names it as `format_type` spells it under `search_path = pg_catalog` (`public.mood`). `introspect` reads labels by `enumsortorder` and skips an enum an extension owns as Unmodeled.

`definitionCatalog` names an enum by its key in the schema's object and finds it from a column by the identity of the value `c.enum(mood)` holds. It refuses a label that is empty, repeated, or over 63 bytes, an enum rolled up under two names, and a column whose enum is not in the Definition.

A created enum lists all its labels. A label added to an existing enum is one `ALTER TYPE ... ADD VALUE ... BEFORE|AFTER` at its declared position, in phase 5 with no Hazard, and a drop is `DROP TYPE` in phase 8. Postgres refuses to use a new label before its transaction commits (`55P04`), so generate rethrows that Shadow error with the fix: commit the label, then use it in the next migration. A type created in the same migration is exempt.

Removing or moving a label swaps the type (ADR-0023), unless a domain uses it.

## Ordering

Each action is one statement-sized change, such as create table, add column, or set default. One `order(actions)` function sorts them into fixed phases (#381). A phase table in `diff/phases.ts` gives each action kind its phase and its rank within the phase, so a new kind fails to compile until it names one. Phase _n_ is the _n_th entry of `PHASES`, so #381 and this list cite phases by number and the code by name. The phases, with the kinds each will hold once v0.2 lands:

1. `RENAME` of tables, columns, enums, domains, labels, and an enum type swap's old type.
2. Payload-matched renames of constraints, indexes, sequences, and domain checks, which compare under the names phase 1 gives.
3. Drop foreign key, index, unique constraint, primary key.
4. Drop column, then table.
5. Create or alter schema or type: create schema, enum, domain; domain alters and checks; enum `ADD VALUE`. All before columns, so a new column gets the new domain default.
6. Create table, add column, then column alters: drop default, drop identity or expression, type (an enum swap's retypes included), NOT NULL, set default or expression, add identity or switch identity mode.
7. Add primary key, unique constraint, index, foreign key.
8. Drop domain, then enum, after the retypes.
9. Drop schema, last so a type drop precedes it.

Phases suffice because every dependency edge runs between kinds, never between two objects of one kind: a foreign key needs its tables and keys, a column its enum or domain, a domain its enum. Phases place each edge's two ends apart, so they never meet a cycle. A topological sort waits for a kind that references its own kind, such as a view or function (v0.5).

Ranks within a phase follow #381's listed order and leave gaps for kinds that land later, so adding one never renumbers another. Within a rank, ties keep catalog order, which `introspect` sorts by name for schemas, tables, and constraints and by position for columns, so new columns follow the Definition. Drops, including the drop half of a changed key, follow the source catalog, and everything else the target catalog.

Dropping a table or column drops what it holds, so no separate drop is emitted for its children, except a foreign key, which always gets its own `DROP CONSTRAINT`. A schema drop without `CASCADE` refuses while the schema holds anything, so each of its tables drops first, without its children. Keys drop in phase 3 and add in phase 7, so a changed key is rebuilt around the column changes it spans.

Within phase 6, each drop runs before the change it would block: Postgres refuses to add an identity to a column that has a default or isn't NOT NULL, and to drop NOT NULL from an identity column. A type change drops the old default first and sets it again afterward, because Postgres refuses to retype a column whose default can't be cast, and otherwise keeps the default cast to the old type.

## SQL rules

- Never `CASCADE` (ADR-0013).
- A default renders in parentheses (`default (now())`), so any expression the Definition writes parses.
- A generation expression renders inline in `CREATE TABLE` and `ADD COLUMN` as `generated always as (<expression>) stored|virtual`, changes with `ALTER COLUMN ... SET EXPRESSION`, and drops with `DROP EXPRESSION` from a stored column. Postgres cannot make a plain column generated, switch one between stored and virtual, or drop the expression of a virtual one, so each of those drops the column and adds it back (appended, with its keys), which carries `data_loss`.
- A column's identity is added or dropped, or switched between `always` and `by default` with `ALTER COLUMN ... SET GENERATED`. Sequence options are not modeled.
- Primary keys and unique constraints drop with `ALTER TABLE ... DROP CONSTRAINT` in phase 3 and add with `ALTER TABLE ... ADD CONSTRAINT` in phase 7, never inline in `CREATE TABLE`, which also silently drops an inline unique that duplicates the primary key.
- Foreign keys add with `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` in phase 7 after the tables and keys they need, never inline, so self references and cycles work. The statement leaves out the clauses at Postgres's defaults (`NO ACTION`, `MATCH SIMPLE`, not deferrable). Each drops with its own `DROP CONSTRAINT` in phase 3 before the keys it needs, even under a dropped table, since its target table may drop first.
- A new column appends; column order differences are ignored, since Postgres can't reorder columns.
- A type change is a plain `ALTER COLUMN ... TYPE` with no `USING`, except an enum swap's retype. When a cast is needed, edit the Current migration by hand.
- A table or column with a `renamedFrom` marker renames with `ALTER TABLE ... RENAME TO` or `ALTER TABLE ... RENAME COLUMN` in phase 1, tables first, so the column statements and every later statement use the new names. A rename combined with a retype emits the `RENAME` first. Without a marker, a renamed key drops and creates, flagged as data loss (ADR-0010, ADR-0024).

## Hazards

Each action kind declares its Hazards (`data_loss`, `rewrite`, `access_exclusive_lock`, `share_row_exclusive_lock`, `rename`) in a table, classified from the catalog, not the SQL text. Each Hazard is written as a `-- hazard: <kind>` comment above its statement, and generate returns them with their statements. Generation never blocks on a Hazard; commit does, per kind (ADR-0015).

Commit also refuses a line that matches `--+\s*hazard\s*:` (case-insensitive, singular) without being a `-- hazard: <kind>` comment above a statement, such as an indented, unspaced, recased, trailing, or mid-statement one, since that would drop its gate by accident; deleting the comment drops it on purpose.

- `data_loss`: a dropped column or table (so a rename too, ADR-0010, unless a `renamedFrom` marker declares it, which carries `rename` instead, ADR-0024), and a type change that converts values without an error but not back, such as `numeric(10,2)` to `integer`, `timestamptz` to `date`, or `double precision` to `real`. A change that fails on a value that doesn't fit, such as `bigint` to `integer`, loses nothing, since the statement rolls back.
- `rewrite`: a type change Postgres can't make in place (text to an enum, an enum to text, and one enum to another among them), and a new column whose default calls a volatile function, that is an identity, or that is stored generated, and a new expression on a stored generated column, because each row needs its own value. A virtual column computes on read and rewrites nothing.
  - In place are only `varchar(n)` to a longer `varchar(m)`, `varchar`, or `text`, `text` to `varchar`, and `numeric(p,s)` to `numeric(q,s)` with `q >= p` or to unbounded `numeric`. `timestamp` and `timestamptz` skip the rewrite only in a UTC session, which a migration can't count on, so they count as a rewrite.
  - Any element type change rewrites, even `varchar(20)[]` to `varchar(40)[]`, and keeps the element pair's `data_loss`. Array to scalar carries every Hazard; scalar to array has no implicit cast, so Shadow verification refuses it.
  - A default is volatile when its expression calls a function that `pg_proc` marks volatile, which `introspect` reads by function name, since `pg_depend` omits built-in functions.
- `access_exclusive_lock`: a statement that holds the lock while it does work that grows with the table. Every `ALTER TABLE` takes that lock, but only a rewrite (which therefore carries both kinds), `SET NOT NULL` (a scan of every row), and adding a primary key or unique constraint (an index build) hold it past a catalog change. Adding a key to a table created in the same migration is empty, so it carries nothing.
- `share_row_exclusive_lock`: adding a foreign key to a table that already exists. The statement scans the table while it holds `SHARE ROW EXCLUSIVE` on it and on the table it points at, which blocks writes but not reads. A foreign key on a table created in the same migration carries nothing. Generate doesn't split the add into `NOT VALID` then `VALIDATE CONSTRAINT` (ADR-0020), since the split only helps when the two commit separately.
- `rename`: a table or column rename. The statement only changes the catalog, but app code still on the old name breaks between `migrate` and its deploy, so accepting it should be explicit (ADR-0024).

A type v0.1 doesn't classify carries every Hazard, since only the gate can say it is safe.

## Postgres versions

v0.1 supports Postgres 18 and newer, and CI runs 18 and, once released, 19. `generate` and `reset` refuse an older server with an error naming the minimum. `generate` hits the check in `withShadowDatabases` and `introspect`, which read `server_version_num`; `reset` checks before it drops or replays anything. `introspect` branches in TypeScript when a catalog differs between versions.
