# Postgres and postgres.js facts for v0.3 statements

Research for #654, child of the v0.3 map #652. Feeds the grilling tickets #655 (order, limit, operators), #657 (update and delete), #658 (joins), #659 (upsert), #660 (named placeholders).

Sources: Postgres 18 docs (`https://www.postgresql.org/docs/18/<page>`), postgres.js 3.4.9 source in `node_modules/postgres/src/`, and this repo's builder and driver. Each fact says how it is known:

- **server** means confirmed on PostgreSQL 18.6 (`node scripts/test-db.ts`), through psql or through `postgresJsDriver` with the repo's `postgresJsTypes` and `postgresJsConnection`.
- **docs** means read in the Postgres 18 docs this session, not run.
- **source** means read in postgres.js 3.4.9.

## How the builder reaches the server

- `fragment` numbers every interpolated value `$1`, `$2`, ... in order and never reuses one (`src/runtime/sql/sql.ts`, `toSql`). A value used twice becomes two params.
- The driver sends `text` and `params` through `connection.unsafe(text, values, { prepare: true, simple: false })`. It wraps each array param in `connection.typed(value, 0)` (`src/adapters/postgres-js/driver.ts`) and untypes `Date` params (`date-params.ts`).
- `where` combines predicates with `and`. There is no order, limit, join, update, delete, or upsert yet.

## UPDATE ... FROM and DELETE ... USING

1. **Duplicate matches in UPDATE ... FROM update the target row once, from an arbitrary join row.** Docs: "If it does, then only one of the join rows will be used to update the target row, but which one will be used is not readily predictable" (`sql-update`). Server: `t(1)` joined to `s(1,'x1')` and `s(1,'x2')` got `x1`, and `UPDATE 2` counted target rows (ids 1 and 2), not join rows.
2. **RETURNING is per updated target row, but the join row that won is what it shows.** Server: the example above returned 2 rows (not 3), and `returning s.x` showed `x1` for id 1. Docs confirm RETURNING may use columns of the FROM tables (`sql-update`; `sql-delete` says the same for USING). A `returning` list built only from the target table cannot expose the arbitrariness.
3. **DELETE ... USING deletes each target row once.** Server: `delete from t using s where t.id = s.id` with two matches for id 1 gave `DELETE 2` (ids 1 and 2). Its RETURNING returned one row per deleted target row, with one arbitrary `s.x`. The `sql-delete` page says nothing about duplicates.
4. **A USING or FROM with no join condition is a cross join.** Server: `delete from r2 using s2 returning r2.id` deleted every row of `r2`.
5. **SET targets cannot be qualified.** Server: `update w set w.v = 'b'` fails ("SET target columns cannot be qualified with the relation name"); `update w as t set v = 'b' returning t.v` works. The right-hand side and RETURNING can qualify freely.
6. **UPDATE and DELETE have no ORDER BY or LIMIT.** Server: `update r2 set v='a' limit 1` and `... order by id` are syntax errors. Docs: "While there is no LIMIT clause for UPDATE, it is possible to get a similar effect through the use of a Common Table Expression and a self-join" (`sql-update`). Working shape, server-confirmed: `update r2 set v = 'lim' where id in (select id from r2 order by id desc limit 2) returning id`. The docs' own example joins on `ctid` and adds `FOR UPDATE` to the inner select.
7. **Command tag count.** postgres.js reads the count from the `CommandComplete` tag (`connection.js` `CommandComplete`). Server through the driver: `update ... where id = any($1)` reported `count=2`; `delete ... where id = -1` reported `count=0`; with RETURNING, `count` equals the returned rows.
8. **An UPDATE with a FROM that matches nothing reports `UPDATE 0`** (server).

## ON CONFLICT

1. **DO UPDATE needs a target; DO NOTHING does not.** Docs: "For ON CONFLICT DO NOTHING, it is optional to specify a conflict_target; ... For ON CONFLICT DO UPDATE, a conflict_target must be provided" (`sql-insert`). Server: `on conflict do update set ...` fails with "ON CONFLICT DO UPDATE requires inference specification or constraint name".
2. **Target forms.** Server-confirmed: column list (`(id)`), expression (`(lower(email))`, which matched a unique index on `lower(email)`), `ON CONSTRAINT <name>`, and a partial index inferred by `(tag) where active`.
3. **A partial unique index is not inferred without its predicate.** Server: `on conflict (tag)` fails with "there is no unique or exclusion constraint matching the ON CONFLICT specification"; `on conflict (tag) where active` works. Docs: the predicate must satisfy the arbiter index, and any index whose predicate it implies can match.
4. **`ON CONSTRAINT` names constraints, not plain unique indexes.** Server: naming a `create unique index` fails with `constraint "u_tag_active" for table "u" does not exist`. A unique constraint (`constraint u_email_key unique (email)`) works. Docs also prefer inference to naming and say deferrable constraints are not arbiters.
5. **A conflict on a different unique index than the target still raises.** Server: `on conflict (id) do update` with a new `id` but a taken `email` fails with `duplicate key value violates unique constraint "u_email_key"`. DO NOTHING without a target absorbs it.
6. **`excluded` and the target.** Docs: SET and WHERE see the existing row under the table name or alias and the proposed row as `excluded`; BEFORE INSERT trigger effects show in `excluded`. Server: an unqualified column on the right of SET (`set n = n + 1`) fails as ambiguous; `u.n + 1` or an alias (`insert into u as tgt ...`, `tgt.n + 1`) works. `excluded.n` carries the column default when the insert omitted the column.
7. **`DO UPDATE ... WHERE` false returns no row and counts 0.** Docs: "if a row was locked but not updated because an ON CONFLICT DO UPDATE ... WHERE clause condition was not satisfied, the row will not be returned" (`sql-insert`). Server: `INSERT 0 0` and an empty RETURNING. DO NOTHING on a conflict is the same. So `returning` on an upsert cannot tell "skipped" from "nothing happened", and `client.one` on it would fail on a skipped row.
8. **The same key twice in one statement.** Server: DO UPDATE fails with "ON CONFLICT DO UPDATE command cannot affect row a second time" (docs: a cardinality violation). DO NOTHING keeps the first row and drops the second silently.
9. **NULLs in a unique key.** Server: a plain `unique` column accepted two NULL rows; `unique nulls not distinct` (Postgres 15 and later) conflicts on them. An upsert keyed on a nullable column never conflicts on NULL by default.

## RETURNING old and new (Postgres 18)

1. **Syntax.** Docs (`sql-update`, `sql-insert`, `sql-delete`): `RETURNING old.col, new.col`, `old.*`, `new.*`; `RETURNING WITH (OLD AS o, NEW AS n) ...` renames them and hides the default names. Unqualified columns mean new for INSERT and UPDATE, and old for DELETE. Server: all confirmed, including `returning with (old as o, new as nn) o.v, nn.v`.
2. **Missing side is all NULL.** Docs: INSERT has all-NULL old values (except on an upsert that updates), DELETE has all-NULL new values. Server: insert gave `old.v` NULL; delete gave `new.v` NULL.
3. **Upsert.** Server: the update path returned the real old row (`old.id = 1`), the insert path returned NULL old. DO NOTHING hits return no row at all.
4. **A NULL column and an absent row look the same through `old.col`.** Server: an existing row with `v` NULL gave `old.v` NULL and `old.id` 1; a new row gave `old.v` NULL and `old.id` NULL. Check a NOT NULL column (the primary key) or `old.id is null` to tell them apart. `old.* is null` also works because the primary key is never NULL.
5. **Works with FROM and USING.** Server: `update r2 set v = s2.x from s2 ... returning old.v, new.v, s2.x` and `delete ... using ... returning old.v, r2.v, s2.x` ran.
6. **Through the driver** the aliases come back as ordinary columns (`{"o":null,"oid":60,"n":1}`), so the builder's existing alias-to-key mapping applies unchanged. A column read as `old.x` or `new.x` needs a distinct output alias; two `v` columns collide in a row object (psql showed `v | v`).
7. **The repo's enum and domain array text cast (ADR-0023)** applies to `old.col` and `new.col` the same way as to any output column. Not run.

## Left join: all-NULL row versus a NULL column

1. **An unmatched left join yields all-NULL right columns.** Server: `b.id`, `b.note` are NULL; `(b is null)` and `(b.* is null)` are `true`.
2. **A matched row with a NULL column is not NULL as a row.** Server: `b.note` NULL on a matched row gave `b is null` = `false`. `row(1,null) is null` is `false`, `row(null,null) is null` is `true`, and `row(1,null) is not null` is also `false` (a partially-NULL row is neither). The primary key therefore tells "no match" from "matched, column NULL" only because it is NOT NULL. A right table whose columns are all nullable cannot be told apart by `b is null` when a real row is all-NULL.
3. **JSON helpers.** Server: `to_jsonb(b)` and `row_to_json(b)` on the unmatched side return SQL NULL, and `"note": null` inside the object for a NULL column. That is a way to nest the right side in one column, at the cost of JSON text types (dates and bigints) instead of the codecs.
4. **ON versus WHERE.** Server: a `where b.note = 'n1'` on the right table turns a left join into an inner join (the unmatched `a` row vanished). Moving it into `on` kept the unmatched row. The builder's `where` must not silently apply to a joined table's columns if the intent is a left join.
5. **The builder today** types every nullable column as `V | null` and offers `isNull`. A left-joined table's columns would all become `V | null` in the type, which loses the "matched row has a NOT NULL column" fact unless the result nests the right side as a single `row | null`, decided by a NOT NULL column such as `b.<pk> is null`.

## ORDER BY, NULLS, LIMIT, OFFSET, keyset

1. **Default NULL position.** Docs (`queries-order`): "null values sort as if larger than any non-null value; that is, NULLS FIRST is the default for DESC order, and NULLS LAST otherwise." Server: confirmed for `asc`, `desc`, and the explicit `nulls first` and `nulls last`. The mismatch with `desc` is the trap: `order by k desc` puts NULLs on top.
2. **Without a unique ORDER BY, LIMIT and OFFSET are unpredictable.** Docs (`queries-limit`): different LIMIT and OFFSET values can change the plan and the row order, so pages are inconsistent. The docs also say rows skipped by OFFSET are still computed, so a large OFFSET is slow. They do not mention keyset paging.
3. **LIMIT forms.** Server: `limit null` and `limit all` mean no limit; `limit 0` returns nothing; negative `limit` and `offset` fail ("LIMIT must not be negative"); `offset` alone works. `fetch first N rows with ties` returned the tied rows (2 rows for `fetch first 1`).
4. **Param types.** Server (`prepare`): `limit $1 offset $2` types both as `bigint`. Through the driver: a number, a numeric string, a `bigint`, `null` (no limit), and `2**53` all work. `1.5` and `NaN` fail with `invalid input syntax for type bigint`. A JS `null` limit silently removes the limit, so a builder must reject it.
5. **Keyset with row comparison.** Server: `where (n, id) > ($1, $2) order by n, id` works with untyped params (types inferred from the columns). Row comparison is lexicographic. With a NULL on either side the result is NULL, so the row is filtered out (`row(null,1) > row(1,1)` and `row(1,2) > row(1,null)` are both NULL). A keyset page over a nullable sort column needs explicit NULL handling, such as `nulls last` plus a `k is null and id > $2` branch, and mixed ASC and DESC columns cannot use one row comparison. Both need `or` chains (server-confirmed shape: `k < 3 or (k = 3 and id > 1)`).
6. **A tiebreaker is needed for stable pages**, normally the primary key.

## `= ANY($1)` versus `IN (...)`

1. **`= any($1)` takes one param; `IN` takes one per value.** Server through the driver: both work for int, text, uuid, bigint (numbers and bigints), `Date` against `timestamptz` and `date`, and enum values.
2. **Empty list.** Server: `in ()` is a syntax error; `= any('{}')` is false; `<> all('{}')` is true. Through the driver, `[]` works for `= any($1)` (0 rows). An `IN` renderer must special-case an empty list.
3. **NULL.** Docs (`functions-comparisons`): `IN`/`ANY` give NULL, not false, when no element matches and an element is NULL, and a NULL array gives NULL; `NOT IN` with a NULL element gives NULL, not true. Server: `id not in (1, null)` and `id <> all(array[1,null])` returned no rows. Through the driver, `e <> all($1)` with `["a", null]` returned 0 rows. A `notIn` over a user array that may hold `null` silently returns nothing.
4. **Param count limit.** Source (`connection.js` lines 186-187): `if (q.parameters.length >= 65534) throw MAX_PARAMETERS_EXCEEDED`. Server: 65535 and 65536 `IN` params both failed with that error. An array param counts as one: `= any($1)` with 100,000 elements ran.
5. **How postgres.js sends the array.** Source: the driver's `connection.typed(value, 0)` creates `Parameter(value, 0)`, so `Parse` sends type 0 and Postgres infers the type from the other side (`handleValue`, `Parse`). `ParameterDescription` then fills the OID in (`connection.js` 626-634), and `Bind` serializes with `options.serializers[oid]`, falling back to `'' + x` (`Bind`, lines 954-962). For an array OID that postgres.js knows, the serializer is `arraySerializer`, which writes `{"a","b"}` text with quoted, escaped elements and `null` for null. Server: `prepare ... where id = any($1)` infers `integer[]`; `in ($1,$2)` infers `integer,integer`.
6. **Special characters survive.** Server: strings holding `"`, `,`, `{x}`, `NULL`, and a backslash matched their rows through `= any($1)`.
7. **Untyped array param without a column to infer from comes back as a string.** Server: `select $1 as a` with `[1,2]` returned `"1,2"`; `select $1::int[]` returned `[1,2]`. This applies to any array param in an expression with no typed neighbor.
8. **Enum arrays depend on connection-time type discovery.** Server: `c = any($1)` on an enum column works on a connection opened after the enum existed, and fails with `malformed array literal: "x"` on one opened before (the enum was created in the same session). Source: `fetchArrayTypes` runs once at connect (`connection.js` 768-787) and registers array serializers only for the types it saw. Fixes, server-confirmed on the stale connection: `c = any($1::text[]::schema.enum[])`, or `c in ($1, $2)`. `$1::schema.enum[]` alone does not fix it, and `c::text = any($1::text[])` works but cannot use an index on `c`. This matches ADR-0023's reason for casting enum arrays to text on output.
9. **Date arrays** work against `timestamptz` and `date` columns (server), consistent with `bindDateParams` keeping arrays untyped.

## Named placeholders

1. **postgres.js has no named parameters.** Source: `sql.unsafe(string, args, options)` (`index.js` 119-127) takes a string and a positional array, and the only placeholders it understands are the `$n` Postgres itself reads. The tagged template and `sql(...)` helpers are the other binders. A grep of `node_modules/postgres/src/*.js` for named-parameter handling finds none. Postgres has no named placeholders on the wire either; `Parse` and `Bind` are positional.
2. **So `:name` or `$name` must be mapped by the builder** to `$n` before the text reaches `unsafe`. Today `fragment` already numbers by order of appearance; `toSql` would need a name-to-index table.
3. **A repeated `$n` is typed per use and counts once.** Server and source: a name used twice would map to one `$n`; Postgres types the first use and may reject a later use that disagrees. `date-params.ts` already splits a repeated `Date` `$n` into one param per use, and `driver.ts` documents `ts >= $1 and ts < $1 + interval '1 day'` failing without casts on every use.
4. **An unused param fails.** Server: `select 1 as x` with one param fails with `could not determine data type of parameter $1` (42P18). Fewer values than `$n` fail at Bind with `bind message supplies 1 parameters, but prepared statement ... requires 2` (08P01). A name map that drops an unused name must also drop its value.
5. **A literal `:` is ordinary SQL.** `::` casts, `:` in strings, comments, and dollar-quoted bodies all contain `:`. `date-params.ts` already carries a tokenizer that skips comments, strings, quoted names, and dollar-quotes; a name scanner would need the same rules.
6. **Undefined values.** Source: `handleValue` throws `UNDEFINED_VALUE` for `undefined` (`types.js` 77-84), so a name with no value in the map must be caught before it reaches the driver.

## Open questions

### #655 order, limit, operators

- Order by output alias, source column, or both? A key in `select` that renames a column (`renderOutput`) is not a column name in Postgres terms for `order by` unless written as an alias.
- Does `order by` default to `nulls last` for `desc` (the opposite of Postgres) or follow Postgres? Which does the API expose, and by what words?
- Does `limit` reject `null`, negatives, non-integers, `NaN`, and unsafe integers up front, since the server accepts `null` as "no limit"?
- Is there an `offset` at all, given the docs' cost and instability warning? If yes, does it require an `order by`?
- Is keyset paging in scope for v0.3? If so, how does it handle a nullable sort column and mixed directions, given row comparison yields NULL?
- Does `in`/`notIn` render `= any($1)` (one param, any size, needs the enum cast chain on stale connections) or `in ($1, $2, ...)` (parameter limit 65533, empty-list special case)? Does `notIn` refuse `null` elements?
- Should `eq(null)`-style misuse (`= null`) keep being a type error, as now?

### #657 update and delete

- Do `update` and `delete` require a `where` (an unqualified `delete` empties the table)? How is a deliberate full-table change spelled?
- Are `update ... from` and `delete ... using` in v0.3 at all, given the arbitrary-row rule and the cross-join risk when the join condition is forgotten? A sub-select form (`where id in (select ...)`) avoids both.
- Does `returning` on update and delete reuse the insert shape, and do `old` and `new` ship in v0.3? If yes, how do they alias columns that exist on both sides?
- `limit`/`order by` on update and delete: unsupported by Postgres, so is it a type error, a CTE rewrite on the primary key, or absent?
- Does `set` accept only values, or also column expressions (`n = n + 1`), given SET targets cannot be qualified but the right side can?
- Does a statement that changes zero rows throw for `client.one`, as it does for `select`?

### #658 joins

- Is the right side of a left join typed `row | null` as one nested object (decided by the right primary key being NULL), or does each right column become `V | null`?
- Which column decides "no match": the right table's primary key (needs one), or any NOT NULL column? What about a right table with no primary key and all nullable columns?
- How do `where` predicates on a joined table behave: do they apply after the join (turning a left join into an inner one), or only inside `on`?
- How are duplicate column names across tables aliased in the output (`id` on both sides)?
- Which join kinds ship (`inner`, `left`; `right` and `full` flip nullability on the left side)?

### #659 upsert

- Target forms: columns only, or also `ON CONSTRAINT`, expression targets, and partial-index predicates? Inference without the predicate fails for a partial unique index.
- Does `onConflictDoNothing()` without a target ship, given it silently absorbs conflicts on any unique index?
- How does the API write the target-row reference on the right of `set` (`excluded.x` versus the existing row), given an unqualified column is ambiguous?
- What does a skipped row return (DO NOTHING hit or false `where`)? An empty `returning` breaks `client.one`; does the API return `undefined`, or only offer `all`?
- Does `insert ... values` with two rows holding the same key fail fast in the builder, or is the "cannot affect row a second time" server error enough?
- Do `old` and `new` on an upsert ship, and how does a caller tell an inserted row from an updated one (`old.<pk> is null`)?
- A nullable key never conflicts on NULL unless `nulls not distinct`: does the API warn or refuse?

### #660 named placeholders

- Does the builder map names to `$n` itself? postgres.js offers nothing, so this is the only option.
- Is a name used twice one `$n` (typed per use, so casts may be needed) or two params? One `$n` per name matches `date-params.ts` splitting only for `Date`.
- Where does the scan live: one tokenizer shared with `date-params.ts`, or a second one? Both must skip comments, strings, quoted names, dollar quotes, and `::`.
- What happens to an unused value and a missing value (42P18 and 08P01 from the server, `UNDEFINED_VALUE` from postgres.js)? Does the builder check first and say which name?
- Does it apply to the `sql` template only, or to the builder too, which already binds by position and has no use for names?
