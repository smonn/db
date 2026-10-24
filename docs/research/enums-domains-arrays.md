# Postgres facts for enums, domains, and arrays

Research for ticket #373 on the v0.2 map (#370). Facts only: no design recommendation. Verified on PostgreSQL 18.6 (`postgres:18` container), postgres.js 3.4.9 (the repo's pinned version), node-postgres `pg` 8.23.1 with `pg-types` 2.2.0. Every claim carries a source link or says it was run. "Run" means I executed it against the live server; the SQL and scripts are quoted or summarized here, not committed.

## Key findings

1. **A domain column reports its base type's OID; an array of a domain reports the array-of-domain OID.** The server substitutes the base type in the row description for a domain column ([printtup.c, "If column is a domain, send the base type and typmod instead"](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/access/common/printtup.c)). A `posint[]` column reports its own array OID, and postgres.js looks up the element parser by the _domain's_ OID, so the scalar and the array decode differently (run, see Driver side).
2. **Enum and domain OIDs are assigned at `CREATE` from a counter (run: 16390 and up in a fresh database), so the same type gets different OIDs in different databases and after a drop and recreate.** Any OID-keyed driver option has to be built from a catalog read of the database it connects to.
3. **postgres.js cannot tell a NULL array element from the text `NULL`, and it mis-parses some arrays** (run, 3.4.9). `array['sad', null]::mood[]` decodes to `["sad", "NULL"]`, `int[]` null to `NaN`, and a `bigint[]` null throws `SyntaxError` under a `BigInt` parser. `'[0:2]={1,2,3}'::int[]` decodes to `[[1,2,3]]`. node-postgres decodes NULL elements and lower-bounded arrays correctly.
4. **postgres.js learns array type OIDs once per connection, at startup.** An array type created after the connection opened decodes as the raw text `{l1,l2}`, and a JS array sent as a parameter of that type goes out as `l1,l2` and fails (run).
5. **`ALTER TYPE ... ADD VALUE` runs in a transaction, but the value is unusable until commit.** One migration file is one transaction (ADR-0008), so a file that adds a value and also uses it (column default, CHECK, index predicate, insert) fails with `55P04` (run). A type created in the same transaction is exempt.
6. **Enum values cannot be dropped or reordered.** `DROP VALUE` parses and fails with "not implemented". Removing a value means a new type and `ALTER COLUMN ... TYPE ... USING`, a full table rewrite under `ACCESS EXCLUSIVE` (run).
7. **Rewrite rules for the diff** (run, 1000-row table, rewrite detected by a changed `pg_relation_filenode`): a constrained domain forces a rewrite when a column changes to it or when you add a column of it; an unconstrained domain does not. Any array element conversion rewrites, even `varchar(20)[]` to `varchar(40)[]`, where the scalar form is in place. Changing only the dimension count (`int[]` to `int[][]`) is a no-op.
8. **Domain constraints on a domain used by an array column are restricted.** `ALTER DOMAIN ADD CONSTRAINT` (validated), `VALIDATE CONSTRAINT`, and `SET NOT NULL` all fail while any array, composite, or range column uses the domain, or a domain derived from it. `ADD CONSTRAINT ... NOT VALID`, `DROP CONSTRAINT`, and `SET DEFAULT` still work (run; [docs](https://www.postgresql.org/docs/18/sql-alterdomain.html)).
9. **`format_type` under the pinned `search_path = pg_catalog` always schema-qualifies user types**: `t.mood`, `t."Weird Mood"`, `public.pub_mood[]`. It never shows array dimensions (`integer[]` for `int[][]`) or sizes (run).

## 1. Catalog rows (Postgres 18)

### Enum and domain types: `pg_type`

All run on 18.6. Docs: [pg_type](https://www.postgresql.org/docs/18/catalog-pg-type.html).

| Object                                   | `typtype` | `typcategory` | `typelem`  | `typbasetype`       | `typtypmod` | `typndims` | `typnotnull` | `typdefault`                                      |
| ---------------------------------------- | --------- | ------------- | ---------- | ------------------- | ----------- | ---------- | ------------ | ------------------------------------------------- |
| enum `mood`                              | `e`       | `E`           | 0          | 0                   | -1          | 0          | f            | null                                              |
| array type `_mood`                       | `b`       | `A`           | `mood` oid | 0                   | -1          | 0          | f            | null                                              |
| domain over `integer` NOT NULL DEFAULT 1 | `d`       | `N` (base's)  | 0          | `integer`           | -1          | 0          | t            | `1`                                               |
| domain over `varchar(255)`               | `d`       | `S`           | 0          | `character varying` | 259         | 0          | f            | null                                              |
| domain over `integer[]`                  | `d`       | `A`           | **0**      | `integer[]`         | -1          | 1          | f            | null                                              |
| domain over domain                       | `d`       | base's        | 0          | the inner domain    | -1          | 0          | f            | copied from the inner domain at create time (`1`) |
| domain over enum                         | `d`       | `E`           | 0          | the enum            | -1          | 0          | f            | null                                              |

- Every enum, domain, and composite type gets an automatic array type (`typarray` on the element row, `typelem` back on the array row; `typtype` of the array is `b`, `typcategory` `A`). Array types of domains exist (`_posint`). `typarray` of an array type is 0, so there is no array of array: `int[][]` is one 2-D array type.
- A domain over an array has `typcategory = 'A'` but `typelem = 0`. It is not an array type for subscripting purposes, and its `typndims` is the declared dimension count ([docs](https://www.postgresql.org/docs/18/catalog-pg-type.html): "typndims is the number of array dimensions for a domain over an array").
- `typtypmod` is the base type's modifier. `format_type(typbasetype, typtypmod)` spells the base: `character varying(255)`, `integer[]`, `t.mood`, `t.posint`.
- A domain over a collatable type has `typcollation <> 0` (`C` in my run, from `COLLATE "C"`).
- A domain's default is `typdefault` (text) and `typdefaultbin` (expression tree). `pg_get_expr(typdefaultbin, 0)` renders it (`1`).
- Dependencies (`pg_depend`, run): a column depends on its type with `deptype n` (also on the array type for an array column: `t.mood[]` and `t.posint[]` are separate referenced objects); an array type depends on its element with `deptype i`; a domain depends on its base type or inner domain with `n`; a domain constraint depends on its domain with `a`. A creation order of enums and base-type domains, then dependent domains, then tables follows these edges.

### Enum values: `pg_enum`

Docs: [pg_enum](https://www.postgresql.org/docs/18/catalog-pg-enum.html), [enum types](https://www.postgresql.org/docs/18/datatype-enum.html).

- Columns: `enumtypid`, `enumsortorder` (`float4`), `enumlabel`, `oid`. Order the values by `enumsortorder`, not `oid`.
- `ADD VALUE ... BEFORE/AFTER` assigns a fractional sort order. After `'first' before 'sad'`, `'mid2' after 'ok'`, `'mid' before 'happy'` (run): `first 0`, `sad 1`, `ok 2`, `mid2 2.25`, `mid 2.5`, `happy 3`. Comparison operators follow `enumsortorder`.
- Labels are case-sensitive, whitespace-significant, and at most 63 bytes ([docs](https://www.postgresql.org/docs/18/datatype-enum.html), run: 64 bytes fails with `42602`). An **empty label is accepted** (run). A **zero-label enum is accepted** ([docs](https://www.postgresql.org/docs/18/sql-createtype.html)). A duplicate label in `CREATE TYPE` fails with a `pg_enum_typid_label_index` unique-constraint violation (run), while `ADD VALUE` of an existing label fails with `42710`.
- Labels with commas, quotes, braces, backslashes, spaces, `NULL`, and non-ASCII all round-trip (run); see the array-literal quoting in the driver section.

### Domain constraints: `pg_constraint`

Docs: [pg_constraint](https://www.postgresql.org/docs/18/catalog-pg-constraint.html) ("Check constraints on domains are stored here, too"; `contypid` is "the domain this constraint is on; zero if not a domain constraint").

Run on 18.6:

```text
 domain  | conname         | contype | convalidated | pg_get_constraintdef(oid)
 posint  | posint_not_null | n       | t            | NOT NULL
 posint  | posint_pos      | c       | t            | CHECK ((VALUE > 0))
 posint  | posint_small    | c       | f            | CHECK ((VALUE < 1000)) NOT VALID
```

- A domain's NOT NULL appears twice: `pg_type.typnotnull = true` and a `contype = 'n'` row in `pg_constraint` (auto-named `<domain>_not_null`). A name can be given (`ADD CONSTRAINT nn NOT NULL`).
- An unnamed CHECK is named `<domain>_check` (run: `ints_check`). Several CHECKs fire in alphabetical order by name ([docs](https://www.postgresql.org/docs/18/sql-createdomain.html)).
- `convalidated = false` marks `NOT VALID`; `pg_get_constraintdef` appends `NOT VALID`.

### Array columns: `pg_attribute`

Run:

| Column as written | `atttypid`            | `atttypmod` | `attndims` | `format_type`             |
| ----------------- | --------------------- | ----------- | ---------- | ------------------------- |
| `int[]`           | `integer[]`           | -1          | 1          | `integer[]`               |
| `int[][]`         | `integer[]`           | -1          | 2          | `integer[]`               |
| `int[3]`          | `integer[]`           | -1          | 1          | `integer[]`               |
| `varchar(20)[]`   | `character varying[]` | 24          | 1          | `character varying(20)[]` |
| `numeric(10,2)[]` | `numeric[]`           | 655366      | 1          | `numeric(10,2)[]`         |
| `t.mood[]`        | `t.mood[]`            | -1          | 1          | `t.mood[]`                |
| `t.posint[]`      | `t.posint[]`          | -1          | 1          | `t.posint[]`              |

- **Dimensions and sizes are not enforced.** `attndims` is "any nonzero value effectively means it's an array" ([pg_attribute](https://www.postgresql.org/docs/18/catalog-pg-attribute.html)); "declaring the array size or number of dimensions in CREATE TABLE is simply documentation" ([arrays](https://www.postgresql.org/docs/18/arrays.html)). Run: an `int[3]` column stored `{1,2,3,4,5}`, and an `int[][]` column stored the 1-D `{1,2}`; `array_ndims` reported the stored dimensions.
- `attndims` is the only catalog trace of the declared dimension count. `ALTER COLUMN TYPE int[][]` on an `int[]` column updated `attndims` from 1 to 2 with no rewrite (run).
- `atttypmod` for an array is the element's modifier. A column whose type is a domain has `atttypmod = -1`; the domain's own modifier lives in `pg_type.typtypmod`.

### `format_type` spellings

[`format_type(oid, typmod)`](https://www.postgresql.org/docs/18/functions-info.html) schema-qualifies a type unless it is visible on the `search_path` (run). The architecture pins `search_path = pg_catalog` in `introspect`:

```sql
begin isolation level repeatable read read only;
set local search_path = pg_catalog;
select attname, format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'm.t'::regclass and attnum > 0;
```

```text
 a | integer[]                          b | public.pub_mood[]
 c | m."Mixed Case"[]                   d | timestamp(3) without time zone[]
 e | character varying[]                f | bit(3)[]
 g | character(2)[]                     h | interval second(2)[]
 i | time(2) with time zone[]
```

- Enum, domain, and their arrays: `schema.name` and `schema.name[]`, with identifier quoting only when needed (`"Mixed Case"`, `"Weird Mood"`). With `search_path = t, pg_catalog` the same types print unqualified (`mood`, `"Weird Mood"`), so the spelling depends on the session `search_path`.
- A type in `public` is qualified too (`public.pub_mood[]`) when `search_path` is `pg_catalog`.
- Dimension count and sizes never appear.

### A working introspection query set (run on 18.6)

```sql
begin isolation level repeatable read read only;
set local search_path = pg_catalog;

-- enum and domain types (array types are typtype 'b', so they do not appear; extension members skipped)
select n.nspname as schema, t.typname as name, t.typtype as kind,
       format_type(t.typbasetype, t.typtypmod) as base_type,
       t.typnotnull as not_null,
       pg_get_expr(t.typdefaultbin, 0) as default_expr,
       c.collname as collation
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
left join pg_collation c on c.oid = t.typcollation
  and t.typcollation <> (select oid from pg_collation where collname = 'default')
where t.typtype in ('e', 'd')
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e');

-- enum labels in declared order
select n.nspname, t.typname, e.enumlabel, e.enumsortorder
from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
order by 1, 2, e.enumsortorder;

-- domain constraints (contype 'n' NOT NULL, 'c' CHECK; convalidated false = NOT VALID)
select n.nspname, t.typname as domain, c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid)
from pg_constraint c join pg_type t on t.oid = c.contypid join pg_namespace n on n.oid = t.typnamespace;

-- columns: spelling and declared dimension count
select attname, format_type(atttypid, atttypmod) as type, attndims
from pg_attribute where attrelid = 't.items'::regclass and attnum > 0 and not attisdropped;
commit;
```

## 2. DDL limits

All "run" results are from 18.6 in a scratch container. Lock names come from `pg_locks` for the session, read inside the open transaction.

### `ALTER TYPE ... ADD VALUE`

Docs: [ALTER TYPE notes](https://www.postgresql.org/docs/18/sql-altertype.html): "If ALTER TYPE ... ADD VALUE ... is executed inside a transaction block, the new value cannot be used until after the transaction has been committed."

- It runs inside `BEGIN ... COMMIT` (run). Only the _use_ is blocked, with `55P04 unsafe use of new value "new" of enum type d.mood` and the hint "New enum values must be committed before they can be used."
- Each of these failed with `55P04` after an `ADD VALUE` in the same transaction (run): `select 'new'::d.mood`, `insert ... values ('new')`, `alter table ... add column x d.mood default 'new'`, `alter column m set default 'new'`, `add constraint ... check (m <> 'new')`, and `create index ... where m = 'new'`.
- Adding the value and not using it succeeds. After the commit, the next transaction can use it (run).
- **Exemption: a type created in the same transaction accepts its added value at once.** Run: `create type d.fresh as enum ('a'); alter type d.fresh add value 'b'; create table d.f (v d.fresh default 'b'); insert into d.f values ('b');` in one transaction passed. Source: [`check_safe_enum_use` in enum.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/enum.c): "it's okay to allow use of uncommitted values belonging to enum types that were themselves created in the same transaction."
- `IF NOT EXISTS` skips an existing label with a notice (`42710`). `BEFORE`/`AFTER` set the sort position (above).
- Lock: only an `ExclusiveLock` on the type object (`locktype = object`, `classid = pg_type`); no relation lock on tables using the type (run). No table rewrite.
- For ADR-0008's one transaction per file: a file that creates a type and adds a value to it can use that value; a file that adds a value to an existing type cannot use it before the file's `COMMIT`.

### `ALTER TYPE ... RENAME VALUE`

Docs (same page): "The value's place in the enum's ordering is not affected. An error will occur if the specified value is not present or the new name is already present."

- Usable at once in the same transaction (run: `rename value 'sad' to 'blue'; select 'blue'::d.mood` works; `'sad'` then fails with `22P02`). A rename to an existing label fails with `42710`.
- Lock: type-object `ExclusiveLock` only; the table's filenode is unchanged (run).
- Stored rows follow, since they hold the value OID. Defaults and CHECK expressions are rendered from the value, so they show the new name: a default `'happy'::d.mood` printed as `'glad'::d.mood` after the rename (run).

### No drop, no reorder

- Docs: "Existing values cannot be removed from an enum type, nor can the sort ordering of such values be changed, short of dropping and re-creating the enum type" ([enum types](https://www.postgresql.org/docs/18/datatype-enum.html)).
- Run: `alter type d.mood drop value 'sad'` fails with `0A000 dropping an enum value is not implemented` (the grammar accepts it, then [gram.y raises](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/parser/gram.y) that error). `alter value` and `reorder values` are syntax errors.
- The recipe that works in a transaction (run):

```sql
alter type d.mood rename to mood_old;
create type d.mood as enum ('sad', 'ok', 'happy');
alter table d.items alter column m type d.mood using m::text::d.mood;
drop type d.mood_old;
```

It rewrote the table (changed filenode) and held `AccessExclusiveLock` on the table and its primary-key index. It fails with `42804 default for column "m" cannot be cast automatically` if the column still has a default, so the default is dropped and re-set around it (run). `USING m::text::d.mood` is required; there is no implicit cast between two enum types.

- Other forms: `RENAME TO` and `SET SCHEMA` work in a transaction (run).

### No `IF NOT EXISTS`, and `DROP`

- `CREATE TYPE IF NOT EXISTS` and `CREATE DOMAIN IF NOT EXISTS` are syntax errors (run). `DROP TYPE IF EXISTS` works.
- `DROP TYPE`/`DROP DOMAIN` with a dependent column fails with `2BP01` and a detail naming the column. `CASCADE` drops the column and its data (run), which is `data_loss` shaped.

### Domain constraints: `ADD CONSTRAINT`, `NOT VALID`, `VALIDATE`

Docs: [ALTER DOMAIN](https://www.postgresql.org/docs/18/sql-alterdomain.html): "When a new constraint is added to a domain, all columns using that domain will be checked against the newly added constraint. These checks can be suppressed by adding the new constraint using the NOT VALID option... Newly inserted or updated rows are always checked against all constraints, even those marked NOT VALID. NOT VALID is only accepted for CHECK constraints."

Table of results (run; domain `posint` used by a 1001-row table column):

| Statement                                                             | Result                                                                              | Table lock                                                   | Rewrite |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| `add constraint c check (...)` that existing rows violate             | error "column "n" of table "items" contains values that violate the new constraint" | n/a                                                          | n/a     |
| `add constraint c check (...)` that passes                            | succeeds                                                                            | `ShareLock` on the table using the domain (one table tested) | no      |
| `add constraint c check (...) not valid`                              | succeeds; `convalidated = false`                                                    | none                                                         | no      |
| `validate constraint c` (rows pass)                                   | succeeds                                                                            | `ShareLock`                                                  | no      |
| `validate constraint c` (rows violate)                                | same "violate" error                                                                | n/a                                                          | n/a     |
| `drop constraint`, `rename constraint`, `set default`, `drop default` | succeed                                                                             | none on tables                                               | no      |
| `set not null` (no nulls)                                             | succeeds; adds the `contype n` row                                                  | `ShareLock`                                                  | no      |
| `set not null` (nulls exist)                                          | error "column contains null values"                                                 | n/a                                                          | n/a     |
| `add constraint nn not null not valid`                                | error "NOT NULL constraints cannot be marked NOT VALID"                             | n/a                                                          | n/a     |

- With `NOT VALID` in place, existing violating rows stay readable, and an `UPDATE` of an unrelated column on such a row succeeds. An `UPDATE` that assigns a violating value to the domain column fails (run).
- The docs warn the validating `ADD CONSTRAINT` is "not bulletproof" against concurrent uncommitted inserts, and recommend `NOT VALID`, commit, wait for older transactions, then `VALIDATE`. Inside one migration transaction the two steps cannot be separated by a commit, so the wait cannot happen.
- **Container columns.** Docs: "ALTER DOMAIN ADD CONSTRAINT, ALTER DOMAIN VALIDATE CONSTRAINT, and ALTER DOMAIN SET NOT NULL will fail if the named domain or any derived domain is used within a container-type column (a composite, array, or range column) in any table in the database." Run with `n.posint` used by `has_array.v n.posint[]`:
  - `add constraint ... check` and `set not null` fail: `cannot alter type "n.posint" because column "has_array.v" uses it`.
  - `validate constraint` fails the same way, even after a `NOT VALID` add.
  - `add constraint ... not valid`, `drop constraint`, `drop not null`, and `set default` succeed.
  - A `NOT VALID` constraint still rejects new array elements: `insert into n.has_array values ('{500}')` failed with `value for domain n.posint violates check constraint "big_nv"`, and `'{0}'` failed on the old check.
  - The same failure appeared for a table added afterwards (`add column arr n.posint[]`), and went away once the array table and a composite table holding a derived domain were dropped.
- **Changing a domain's base type is not possible.** `alter domain ... type bigint` is a syntax error (run). `RENAME TO` and `SET SCHEMA` work (run).
- Domain CHECK rules: no subqueries (`cannot use subquery in check constraint`, run); a non-immutable expression such as `value < now()` is accepted and Postgres does not notice stored values that later violate it ([docs](https://www.postgresql.org/docs/18/sql-createdomain.html)). CHECK passes NULL (`UNKNOWN` succeeds); a column "nominally" of a NOT NULL domain can still read as NULL, for example on the nullable side of an outer join (same page).

### Column changes to or from an enum or domain

Docs rules, quoted from [ALTER TABLE notes](https://www.postgresql.org/docs/18/sql-altertable.html): "Adding a column with a volatile DEFAULT..., a stored generated column, an identity column, or a column with a domain data type that has constraints will cause the entire table and its indexes to be rewritten." "Changing the type of an existing column will normally cause the entire table and its indexes to be rewritten. As an exception... if the USING clause does not change the column contents and the old type is either binary coercible to the new type or an unconstrained domain over the new type, a table rewrite is not needed."

Source: [`ATColumnChangeRequiresRewrite`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/tablecmds.c) skips a rewrite only for a bare column reference, a `RelabelType` (binary coercible), a `CoerceToDomain` to a domain with no constraints, and the timestamp/timestamptz pair under a UTC session; every other node (including array element coercion) returns true. The source comment says a constrained domain "could get by with scanning the table and checking the constraint rather than actually rewriting it, but we don't currently try to do that." For `ADD COLUMN` the source notes a domain with constraints gets an explicit NULL default "that will be passed through CoerceToDomain processing" and so rewrites.

Run (1000-row table; "rewritten" = `pg_relation_filenode` changed; every `ALTER TABLE` took `AccessExclusiveLock`, and the rewrites also took a `ShareLock` for index rebuild):

| Change                                                                                     | Rewritten                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| calibrate: `int` to `bigint`                                                               | yes                                              |
| calibrate: `varchar(20)` to `varchar(40)`                                                  | no                                               |
| calibrate: `varchar(20)` to `varchar(10)`                                                  | yes                                              |
| calibrate: `numeric(10,2)` to `numeric(12,2)`                                              | no                                               |
| `text` to enum (`USING txt::d.mood`)                                                       | yes                                              |
| enum to `text` (with or without `USING`)                                                   | yes                                              |
| enum to a second enum (`USING e::text::d.mood2`)                                           | yes                                              |
| enum to the same enum                                                                      | no                                               |
| `int` to domain over `int` **with** CHECK                                                  | **yes**                                          |
| `int` to domain over `int`, no constraint                                                  | no                                               |
| constrained domain to its base `int`                                                       | no                                               |
| domain `posint` to a domain over `posint` that adds a CHECK                                | yes                                              |
| `bigint` to domain over `bigint` (no constraint)                                           | no                                               |
| `int` to domain over `bigint`                                                              | yes                                              |
| `varchar(20)` to domain over `varchar(255)` (no constraint)                                | no                                               |
| `text` to domain over `text` (no constraint)                                               | no                                               |
| `int[]` to `bigint[]`                                                                      | yes                                              |
| `int[]` to `int[][]` or `int[3]`                                                           | no                                               |
| `varchar(20)[]` to `varchar(40)[]`                                                         | **yes** (scalar form: no)                        |
| `varchar(20)[]` to `varchar(10)[]`, to `text[]`; `text[]` to `varchar[]`                   | yes                                              |
| `int` to `int[]` (`USING array[i]`)                                                        | yes                                              |
| `text[]` to `enum[]` (`USING ta::d.mood[]`), `enum[]` to `text[]`                          | yes                                              |
| `int[]` to `posint[]`, `posint[]` to `int[]`                                               | yes                                              |
| `ADD COLUMN` enum, nullable, no default                                                    | no                                               |
| `ADD COLUMN` enum with constant default, also NOT NULL                                     | no                                               |
| `ADD COLUMN` domain without constraints (nullable, or NOT NULL default 1)                  | no                                               |
| `ADD COLUMN` domain **with** CHECK: nullable no default; or default 1; or NOT NULL default | **yes**                                          |
| `ADD COLUMN` domain over a constrained domain                                              | yes                                              |
| `ADD COLUMN` domain over enum (no constraints)                                             | no                                               |
| `ADD COLUMN` array of constrained domain (`posint[]`), nullable                            | no                                               |
| `ADD COLUMN` array, `'{}'` default, including `enum[]` NOT NULL                            | no                                               |
| `ADD COLUMN` array with a volatile default (`gen_random_uuid()`)                           | yes                                              |
| `SET DEFAULT`, `SET NOT NULL`, `DROP COLUMN` on an enum column                             | no (the docs say `SET NOT NULL` scans the table) |

Not tested: a domain whose only constraint is `NOT NULL` for `ADD COLUMN` (the docs and source say "constraints", covering it), and indexes on the changed column.

Failure texts (run): `text` to enum with a bad value fails with `22P02 invalid input value for enum d.mood: "nope"`; `int` to a constrained domain with a violating row fails with `23514 value for domain d.posint violates check constraint "posint_pos"`.

## 3. Driver side

The repo configures postgres.js through `types` (`postgresJsTypes`, keyed by OID) and a `connection` startup object, in `src/adapters/postgres-js/value-types.ts` and `connect.ts`. `fetch_types` stays at its default (true). Both drivers receive values as text.

### postgres.js 3.4.9

Sources: [connection.js](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js), [types.js](https://github.com/porsager/postgres/blob/v3.4.9/src/types.js), [README: Custom Types](https://github.com/porsager/postgres/blob/v3.4.9/README.md#custom-types) and ["Auto fetching of array types"](https://github.com/porsager/postgres/blob/v3.4.9/README.md#auto-fetching-of-array-types). Behavior below was run unless marked "source".

**How decode works.** `RowDescription` stores `parsers[type]` per column from the server's OID. A value with no parser is returned as the text string. The built-in parsers cover numbers (21, 23, 26, 700, 701), json, boolean, date, bytea; everything else is a string (types.js).

**Scalars** (run, one row):

| Column                  | Reported OID   | JS value                          |
| ----------------------- | -------------- | --------------------------------- |
| enum `mood`             | the enum's OID | `"ok"` (string)                   |
| domain over `integer`   | `23` (base)    | `5` (number)                      |
| domain over `bigint`    | `20` (base)    | `"7"` (string, as plain `bigint`) |
| domain over `integer[]` | `1007` (base)  | `[4, 5]`                          |
| domain over enum        | the enum's OID | `"happy"`                         |
| domain over `text`      | `25`           | `"abc"`                           |

A `types` entry keyed by an enum's OID applies to enum scalars and to scalars of domains over that enum (run: an uppercasing parser on `mood` also changed `md`, the domain-over-`mood` column). A `types` entry keyed by a _domain's_ OID never fires for a scalar of that domain, because the column reports the base OID.

**Arrays.** README: "Postgres.js will automatically fetch table/array-type information when it first connects to a database... If you have revoked access to `pg_catalog` this feature will no longer work and will need to be disabled." Source (`fetchArrayTypes`, `addArrayType`):

```js
select b.oid, b.typarray
from pg_catalog.pg_type a
left join pg_catalog.pg_type b on b.oid = a.typelem
where a.typcategory = 'A'
group by b.oid, b.typarray
order by b.oid
```

For each row, `options.parsers[typarray] = xs => arrayParser(xs, options.parsers[oid], typarray)`, so an array column decodes element by element with the parser registered for the _element_ OID. It runs once per connection, after startup (`needsTypes`), and mutates the options' parser table.

Run results (`fetch_types` on, all types existed before connecting):

| Column                                                               | Reported OID        | JS value                                                                                                                       |
| -------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `mood[]`                                                             | the array's OID     | `["sad","ok"]` (strings: enum has no parser, so elements stay text)                                                            |
| `weird[]` (labels with `,`, `"`, `{}`, `NULL`, `'`, `é`, `\`, space) | array OID           | all eight labels correct                                                                                                       |
| `posint[]` (array of domain)                                         | `_posint`'s own OID | `["1","2"]` **strings**, while the scalar `posint` is the number `5`                                                           |
| `bigdom[]`                                                           | `_bigdom`'s OID     | `["7","8"]` strings                                                                                                            |
| `int[]`, `int[][]`                                                   | `1007`              | `[1,2,3]`, `[[1,2],[3,4]]`                                                                                                     |
| `bigint[]`                                                           | `1016`              | `["9","10"]` (elements use the parser registered for OID 20, none by default; with a `BigInt` parser on 20 they were `bigint`) |
| `numeric[]`                                                          | `1231`              | `["1.50","2.25"]`                                                                                                              |
| domain over `int[]`                                                  | `1007`              | `[4,5]`                                                                                                                        |

- **User parsers and arrays.** Registering `{ to, from: [oid], parse }` for a custom OID also makes its array type decode element-wise, when the array type is registered at connect time (run). For arrays of a domain the element OID is the domain's OID, not the base's: `from: [domainOid]` made `posint[]` decode to `["posint:1","posint:2"]` while the scalar column `pi` still decoded as the plain number (run). A domain-over-enum array (`mood_dom[]`) ignored a parser registered on the _enum's_ OID and returned plain strings (run).
- **Stale array types.** A type created after a connection opened is not in that connection's map. Same connection: `select ls` (an `x.late[]` column) returned the raw string `"{l1,l2}"`; a new client returned `["l1","l2"]` (run, B). By source, each new connection re-runs the query and mutates one shared options object, so whether a pooled connection sees a late type depends on whether any connection opened after the type was created (not run).
- **`fetch_types: false`**: arrays arrive as raw text `"{1,2,3}"`, even `int[]` (run).
- **NULL elements** (run): `array['sad',null]::mood[]` decodes to `["sad","NULL"]`; `array['a',null]::text[]` to `["a","NULL"]`; `array[1,null,3]::int[]` to `[1, NaN, 3]`; `array[1.5,null]::numeric[]` to `["1.5","NULL"]`; and `array[1,null]::bigint[]` with a `BigInt` parser on OID 20 **throws** `SyntaxError: Cannot convert NULL to a BigInt`. A text array holding the string `'NULL'` decodes the same as one holding a SQL null. The parser (`arrayParserLoop` in types.js) passes the unquoted token `NULL` to the element parser.
- **Lower bounds** (run): `'[0:2]={1,2,3}'::int[]` decodes to `[[1,2,3]]`, an extra level of nesting. The decoder slices the first character off the text (`column.parser(x.toString('utf8', index + 1, ...))` in connection.js) to drop `{`, which here drops `[`. The text form `[0:2]=` appears only for arrays whose lower bound is not 1.
- 2-D arrays and empty arrays (`{}`) decode correctly (`[[1,2],[3,4]]`, `[]`).

**Parameters** (run unless marked). Bind uses the parameter type the server returns from `Parse`/`Describe`. In `Bind`, a type with a registered serializer uses it; otherwise the value is `'' + x` (connection.js).

- A JS array of strings or numbers goes out with type 0, so the server infers the column's type (`mood[]`) and the registered array serializer applies: inserting `["sad","ok"]` into `mood[]` works, as do `null` elements, `[]`, 2-D arrays, enum labels with commas, quotes, braces, `NULL`, and backslashes.
- `where m = any($1)` with `["ok","sad"]` works, in `unsafe` and in the tagged form.
- `sql.array(["sad","ok"])` fails with `42804 column "ms" is of type x.mood[] but expression is of type text[]`: it types an array of strings as `text[]`. `sql.array(["sad","ok"], arrayOid)` with the enum array's OID works, as does `sql.typed("happy", enumOid)` for a scalar. Both need the OID, which is database-specific.
- `inferType` takes the _element's_ type for an array (`Array.isArray(x) ? inferType(x[0])`), so an array whose first element is a `bigint`, `Date`, `boolean`, or `Uint8Array` is sent with that **scalar** OID. `insert ... bia (bigint[]) values ($1)` with `[1n, 2n]` failed: `42804 column "bia" is of type bigint[] but expression is of type bigint`. (The repo's `date-params.ts` already works around the Date case.)
- A domain-typed target reports the **domain's** OID as the parameter type (`describe()`: `17040` = `posint`, `17045` = `ints`, `17049` = `txtdom`). A serializer registered on the base OID does not fire. For a domain over `integer[]` with a JS array, no serializer is found and `'' + x` yields `7,8`: `22P02 malformed array literal: "7,8"`. An array of a domain over an enum worked (`mood_dom[]` took `["sad","happy"]`), because its array type is registered at connect time like any array type.
- **Stale array types, parameters** (run): on a connection opened before `x.late` existed, sending `["l1","l2"]` into an `x.late[]` column fails with `22P02 malformed array literal: "l1,l2"`, because the unregistered array type falls back to `'' + x`. The same for `= any($1)`.
- The JS-array-to-literal serializer (`arraySerializer`) quotes every element, escapes `\` and `"`, writes `null` for null, and uses `;` only for `_box`.

### node-postgres (`pg` 8.23.1, `pg-types` 2.2.0)

Sources: [pg Result](https://github.com/brianc/node-postgres/blob/pg@8.23.1/packages/pg/lib/result.js), [type-overrides](https://github.com/brianc/node-postgres/blob/pg@8.23.1/packages/pg/lib/type-overrides.js), [utils.js](https://github.com/brianc/node-postgres/blob/pg@8.23.1/packages/pg/lib/utils.js), [pg-types index](https://github.com/brianc/node-pg-types/blob/v2.2.0/index.js) and [textParsers](https://github.com/brianc/node-pg-types/blob/v2.2.0/lib/textParsers.js), [docs: data types](https://node-postgres.com/features/types) ("strings by default").

- **No catalog fetch.** `Result.addFields` calls `types.getTypeParser(dataTypeID, format)` for every column. Parsers are a static OID table (`pg-types`) plus per-client or per-query overrides (`config.types`, `client.setTypeParser(oid, fn)`, or the global `pg.types.setTypeParser`). An OID with no parser uses `String`. A type created after connecting needs no refresh (run: a new enum and its array read correctly, as strings).
- **Same server-side OIDs as postgres.js** (they come from the protocol): enum scalar is the enum's OID, so a string; a domain column reports its base OID (`integer` domain decoded to `5`, domain over `integer[]` to `[4,5]`); an array of a domain or enum reports its own array OID.
- **Arrays of enums and domains come back as raw array text** (run): `ms` is `"{sad,ok}"`, `ws` is the quoted literal `{"a,b","say \"hi\"",...}`, `pis` is `"{1,2}"`, `bds` is `"{7,8}"`, `tds` is `"{abc,def}"`. Arrays with built-in OIDs parse: `int[]` to numbers, `text[]` to strings, `bigint[]` to strings (`["9","10"]`), `numeric[]` to **floats** (`[1.5, 2.25]`, while scalar `numeric` stays a string), `date[]` and `timestamp[]` to `Date`.
- **Registering an array parser needs the array OID.** Run: `types.setTypeParser(arrayOid, types.getTypeParser(1009))` (reusing the `text[]` parser) made `mood[]` and `weird[]` decode correctly, labels with commas, quotes, braces, and `NULL` included; `types.getTypeParser(1007)` on `posint[]` gave `[1,2]`. `pg.types.arrayParser.create(text, transform).parse()` is exported for a custom element transform (run: `{sad,NULL,"a,b","say \"hi\""}` gave `["sad",null,"a,b","say \"hi\""]`). There is no element-parser lookup by element OID as in postgres.js.
- **NULL elements and lower bounds decode correctly** (run, `postgres-array` 2.0.0, which treats unquoted `NULL` as null): `[1,null,3]`, `["a",null,"NULL"]`, `["sad",null,"ok"]` after registering, `bigint[]` null as `["1",null]`, and `'[0:2]={1,2,3}'::int[]` as `[1,2,3]` (bounds dropped).
- **Parameters.** [`prepareValue`](https://github.com/brianc/node-postgres/blob/pg@8.23.1/packages/pg/lib/utils.js) turns a JS array into a quoted array literal (`arrayString`: every element quoted, `\` and `"` escaped, `null` as `NULL`, nested arrays recursed), and sends it with the parameter type unspecified, so the server infers it from context. Run: enum arrays, `null` elements, weird labels, `[]`, 2-D `int[][]`, `[1n, 2n]` into `bigint[]`, domain `posint[]`, domain over `int[]`, and `= any($1)` all worked. It does not emit `;`-delimited arrays (the comment says it "won't work for types like box").
- The text-vs-binary format is a per-query option; both results above used text.

### Comparison for the Codec port

| Need                                       | postgres.js 3.4.9                                                                                                                                 | node-postgres 8.23.1                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Decode enum scalar                         | string, no config                                                                                                                                 | string, no config                                                  |
| Decode domain scalar                       | by base OID, so base-type parsers apply                                                                                                           | same                                                               |
| Decode enum/domain array                   | string elements if the array type is known at connect; raw text if created later                                                                  | raw text unless an array parser is registered by array OID         |
| Element parser for an array of custom type | looked up by the element's (or domain's) OID automatically                                                                                        | none; register the array OID                                       |
| NULL array elements                        | `"NULL"` string, `NaN`, or `BigInt` throw                                                                                                         | `null`                                                             |
| Lower-bounded array                        | wrong nesting                                                                                                                                     | bounds dropped                                                     |
| Array type created after connect           | stale on that connection                                                                                                                          | no refresh needed                                                  |
| Array param typing                         | server infers for strings/numbers; first-element OID for `bigint`/`Date`/`boolean`/`Uint8Array`; unknown array type falls back to `String(array)` | server infers; all tested shapes worked                            |
| Where to register types                    | `postgres({ types })` at construction (also `fetch_types`)                                                                                        | `new Client({ types })`, `client.setTypeParser`, per-query `types` |

## Open questions

### For #377 "Column values can't override their TypeScript mapping"

1. Where does a Codec attach to a column: the column's Postgres type (spelled via `format_type`), its OID, or the Definition column object? Enum, domain, and array OIDs differ in every database, and a domain column reports its base OID while an array of a domain reports the array-of-domain OID. Which key reaches the driver `types` option, and who builds the OID map (the connect step, from a catalog read of the Database it connects to)?
2. Does a Codec on a domain apply to the domain's scalar column, to arrays of that domain, or to both? A scalar needs the base OID (shared with every plain column of that base type) and an array needs the domain's OID. Per-column overrides cannot be expressed through postgres.js's per-OID `types`; a per-column override needs row-level mapping after the driver, or a cast in the `SELECT`.
3. Is NULL inside an array part of the Codec contract? Under postgres.js, array elements go through the parser as the text `NULL`. Does the port wrap or replace postgres.js's array parser, or add a post-decode step for arrays?
4. Does the port keep text decoding, with the driver returning raw strings for unknown types (enum, arrays of enum, arrays of domain), and decode in the adapter?
5. The existing `hasPostgresJsTypes` check compares parsers by identity at driver construction. What does an equivalent check mean when the parsers depend on a database's OIDs and on array types registered at connect time?
6. How should parameters be encoded for an array of `bigint`, `Date`, `boolean`, or `Uint8Array` (postgres.js sends the element OID), for a domain over an array (no serializer matches the domain OID), and for an array type unknown to the connection? Should the port always send explicit array OIDs or text literals?
7. Does the decoded TypeScript type of a `numeric[]` follow scalar `numeric` (`string`)? node-postgres returns floats for `numeric[]`; postgres.js returns strings. Same question for `bigint[]` against the `bigint` mapping in ADR-0010.

### For #378 "Definition can't express enums, domains, or arrays"

1. What does the catalog fact for an enum carry: the ordered labels (as one payload or per-value child facts)? Per-value facts make `ADD VALUE` one difference; reordered labels or a removed label has no in-place DDL and needs a type swap with a rewrite.
2. How are the diff actions ordered when an enum value is added and used in the same migration? The value cannot be used in that transaction unless the type is also new in it. Does the diff split the file, refuse, or flag a new Hazard kind? None of `data_loss`, `rewrite`, `access_exclusive_lock` describes it.
3. Which Hazards does each change carry? From the tables above: enum value add and rename carry none on tables; a value removal or reorder is a type swap (`rewrite` + `access_exclusive_lock`, plus `data_loss` if a used value is dropped); `DROP TYPE ... CASCADE` drops columns; a validated domain `ADD CONSTRAINT` takes `ShareLock` on every table using the domain; a column change to a constrained domain rewrites; `ADD COLUMN` of a constrained domain rewrites; an array element change always rewrites. Which of these, if any, does the diff model, and which carry "all Hazards" as an unclassified type does today?
4. Does the Definition model domain constraints as `NOT VALID` plus `VALIDATE` in one file? Inside one transaction there is no gap between them, and the docs' concurrent-insert caveat applies. Or does it refuse/flag this? And how does it handle the array-column restriction (`ADD CONSTRAINT`, `VALIDATE`, and `SET NOT NULL` fail when any array or composite column uses the domain)?
5. How are array dimensions spelled in the Definition, given Postgres does not enforce them and `format_type` never shows them? Is `attndims` part of the catalog payload, or is `integer[]` the only fact (so `int[]` to `int[][]` is no change)?
6. How is a type spelled in the catalog: `format_type` with `search_path = pg_catalog` gives `schema.name` and `schema.name[]` for enums, domains, and their arrays, with quoting only when needed. `definitionCatalog` has to produce the same quoting. Do enums and domains key as their own facts under the schema (`schema\0typename`), alongside tables, so a column fact names its type by that spelling?
7. Is a column's dependency on an enum or domain an ordering edge in `order`? The architecture says "no v0.1 kind references another table, so phases are always correct", and a type referencing nothing but a column referencing a type introduces the first cross-kind dependency (type creation before table, table drop before type drop).
8. Are enum and domain defaults and CHECK expressions modeled as text from `pg_get_expr`/`pg_get_constraintdef`, as column defaults are? Renaming an enum value rewrites the rendered text of defaults and CHECKs that mention it.
9. Does the Definition allow an empty label, a zero-label enum, or labels over 63 bytes? Postgres accepts the first two and rejects the third.
10. Does a domain's NOT NULL fold into a domain fact the way a column's NOT NULL folds into the column (`typnotnull` and the `contype = 'n'` row say the same thing), or is it its own fact?
