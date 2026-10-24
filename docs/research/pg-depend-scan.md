# What a pg_depend scan for Unmodeled blockers needs

Research for [#372](https://github.com/smonn/db/issues/372), feeding the decision ticket [#380](https://github.com/smonn/db/issues/380). Facts only; it does not recommend building the scan.

Checked against Postgres 18.6 (`postgres:18` container) and the `REL_18_STABLE` source. Every query below ran against a fixture with views, a materialized view, foreign keys, triggers, a policy, a publication, an inheritance child, partitions, and four kinds of function. "Verified" means the query output was compared with the error Postgres raised for the same statement.

## Findings

1. **A scan is a transitive walk, not one `pg_depend` lookup.** An Unmodeled view reaches a modeled column through `pg_rewrite` (`n`, on the column). A foreign key reaches a modeled unique constraint through the constraint's index (`n`, on the index, which is `i` on the constraint). A function taking a table's row type reaches the table through `pg_type` (`i` on the table). Only a closure walk that follows owners finds these.
2. **Only `n` edges block, and an object is a blocker only if no path reaches it through a non-`n` edge.** This is the rule `DROP ... RESTRICT` applies. A recursive query implementing it (below) matched Postgres's own `2BP01` object list in 8 of 9 cases, including `DROP SCHEMA` (20 objects) and a multi-table `DROP`. The miss is an inheriting child table, which `pg_depend` does not record per column.
3. **`ALTER COLUMN ... TYPE` follows a different rule from `DROP`.** It reads only the column's direct dependents, rebuilds indexes, constraints, and statistics, and refuses for a view or rule, function, trigger, policy, generated column, or publication `WHERE`. It raises `0A000` on the first one it meets.
4. **Verification reports all blockers of one failing statement but stops at the first failing statement.** `2BP01` lists up to 100 dependents in `DETAIL`. The `0A000` retype error names one object even when five block. A script that fails at statement 1 never reaches statement 2's blockers.
5. **`pg_shdepend` never blocks a modeled object.** Its referenced side is only roles and tablespaces.
6. **Some things have no `pg_depend` row at all:** string-bodied function bodies, PL/pgSQL, dependencies on built-in (pinned) objects, and the parent-to-child link of inheritance on columns.
7. **`pg_identify_object_as_address` returns `object_names` arrays that line up with the catalog key segments** (`{app,users,email}` for column `email`), so no text parsing is needed to name a modeled target. The `pg_describe_object` text and the `2BP01` `DETAIL` are human text that Postgres may translate.

## What reaches a modeled object

Observed direct `pg_depend` rows whose referenced object is a modeled table, column, or key constraint (query in [Appendix A](#a-direct-dependents-of-modeled-objects)). Dependent catalog in parentheses.

Meanings of each `deptype`: [`pg_depend`](https://www.postgresql.org/docs/18/catalog-pg-depend.html), enum in [`dependency.h`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/catalog/dependency.h).

| Referenced                         | `n` (blocks a drop)                                                                                                                                                                                                                                                                | `a` (dropped with it)                                                                                                                                                                   | `i` (part of it)                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table                              | inheriting child table (`pg_class`); a view that uses the whole row (`pg_rewrite`)                                                                                                                                                                                                 | indexes, triggers, policies, publication membership, rules on the table                                                                                                                 | row type (`pg_type`; a function taking the row type blocks through it), TOAST table                                                                |
| Column                             | foreign key (`pg_constraint`), view or materialized view rule (`pg_rewrite`), `BEGIN ATOMIC` function (`pg_proc`), trigger `WHEN` or `UPDATE OF` (`pg_trigger`), policy, publication column list or `WHERE` (`pg_publication_rel`), a generated column's expression (`pg_attrdef`) | NOT NULL, CHECK, unique and primary key constraints (`pg_constraint`), the column's default (`pg_attrdef`), indexes, extended statistics (`pg_statistic_ext`), a sequence `OWNED BY` it | identity sequence (`pg_class`), generated-column expression (`pg_attrdef`)                                                                         |
| Constraint (primary key or unique) | none directly                                                                                                                                                                                                                                                                      | none                                                                                                                                                                                    | the index (`pg_class`). A foreign key depends on that index (`n`), not on the constraint: the scan reaches the foreign key by following the index. |
| Type                               | a user-defined type used by a modeled column: the column depends on the type (`n`), so the type is the referenced side. Built-in types have no row (pinned, see below).                                                                                                            | none                                                                                                                                                                                    | none                                                                                                                                               |

Notes:

- PostgreSQL 18 stores NOT NULL as `pg_constraint` rows (`contype n`), so every NOT NULL column has an `a` row. They are modeled (folded into the column) and never block.
- `P` and `S` (partition) and `e` and `x` (extension) did not appear on modeled tables in the fixture. Partitions of a `relkind p` table gave `a` to the parent table (`app.part_1` on `app.part_parent`). Partitioned tables are not a v0.1 kind. `e` and `x` mark extension members, which introspect already skips. Their documented meanings are in [`pg_depend`](https://www.postgresql.org/docs/18/catalog-pg-depend.html).
- Several modeled kinds appear as dependents of modeled objects: a generated column depends on the column its expression reads, and an inheriting table depends on its parent. A scan has to tell "modeled and handled by the diff" from "Unmodeled".
- "Reaches" is per path. A publication relation is `a` on its table and `n` on its columns. `DROP TABLE` accepts it (the `a` path wins); `DROP COLUMN` refuses (only the `n` path exists). The scan therefore has to be computed per planned action, not once per object.

## The blocking rule

[`reportDependentObjects`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/dependency.c) (near line 1020) decides which dependents refuse a `RESTRICT` drop. Its comment states the rule: if, at any stage of the search, an object "was reached via an AUTO, INTERNAL, PARTITION, or EXTENSION dependency, then it's okay to delete it even in RESTRICT mode". Otherwise it is added to `DETAIL` as `X depends on Y` and the drop fails with `ERRCODE_DEPENDENT_OBJECTS_STILL_EXIST` (`2BP01`).

[`findDependentObjects`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/dependency.c) adds two behaviours a scan must copy:

- An internally dependent object (`i`, or `e`) redirects the drop to its owner. A rule's `i` owner is its view, so the error names the view, not the rule.
- Dependents of a whole object include dependents of its columns.

[Dependency tracking](https://www.postgresql.org/docs/18/ddl-depend.html) adds one more: `DROP` of several objects needs `CASCADE` only for dependents outside the list. Dropping `app.orders` and `app.users` together removes the two foreign keys from the blocker list (verified).

Pinned objects get no row: [`pg_depend`](https://www.postgresql.org/docs/18/catalog-pg-depend.html) says the mechanism "doesn't bother to make `pg_depend` entries showing dependencies on them", so a `numeric` column has no row on the `numeric` type. `architecture.md` already records the same effect for volatile built-in functions in defaults. The fixture confirms it: `default now()` leaves no row on `now()`, while a default calling a user function (`app.default_fn()`) leaves an `n` row.

### Working SQL: blockers of a drop

Takes parallel arrays of targets (`pg_class`/`pg_constraint`/`pg_namespace` catalog oid, object oid, sub-object id; `0` for a whole object, the column number for a column). Returns the Unmodeled-or-not objects that would refuse the drop. Run on the fixture; output matched Postgres in every case ([Appendix B](#b-comparison-with-postgress-own-errors)).

```sql
prepare drop_blockers(oid[], oid[], int[]) as
with recursive
targets(classid, objid, objsubid) as (select * from unnest($1, $2, $3)),
closure(classid, objid, objsubid) as (
  select * from targets
  union
  select x.classid, x.objid, x.objsubid
    from closure c
   cross join lateral (
     -- dependents of the node; a whole object covers its columns
     select d.classid, d.objid, d.objsubid
       from pg_depend d
      where d.refclassid = c.classid and d.refobjid = c.objid
        and (c.objsubid = 0 or d.refobjsubid = c.objsubid)
     union all
     -- the owner of an internally dependent node: Postgres redirects the drop to it
     select d.refclassid, d.refobjid, d.refobjsubid
       from pg_depend d
      where d.classid = c.classid and d.objid = c.objid
        and (d.objsubid = c.objsubid or c.objsubid = 0)
        and d.deptype = 'i'
   ) x
),
blockers as (
  select c.*
    from closure c
   where not exists (select 1 from targets t
                      where t.classid = c.classid and t.objid = c.objid
                        and (t.objsubid = 0 or t.objsubid = c.objsubid))
     -- a column is part of its table when the table is in the closure too
     and not (c.objsubid > 0 and exists (select 1 from closure w
                      where w.classid = c.classid and w.objid = c.objid and w.objsubid = 0))
     -- reached through any non-normal edge: dropped silently, not a blocker
     and not exists (
       select 1
         from pg_depend e
         join closure r
           on r.classid = e.refclassid and r.objid = e.refobjid
          and (r.objsubid = 0 or r.objsubid = e.refobjsubid)
        where e.classid = c.classid and e.objid = c.objid
          and (c.objsubid = 0 or e.objsubid = c.objsubid)
          and not (e.refclassid = e.classid and e.refobjid = e.objid)
          and e.deptype <> 'n')
)
select a.type, a.object_names, a.object_args, i.identity
  from blockers b
  cross join lateral pg_identify_object_as_address(b.classid, b.objid, b.objsubid) a
  cross join lateral pg_identify_object(b.classid, b.objid, b.objsubid) i
 order by 1, 2::text;
```

Example, dropping column `app.users.email`:

```
         type         |         object_names         | object_args |              identity
----------------------+------------------------------+-------------+------------------------------------
 policy               | {app,users,users_p}          | {}          | users_p on app.users
 publication relation | {app,users}                  | {pub_users} | app.users in publication pub_users
 table constraint     | {app,orders,orders_email_fk} | {}          | orders_email_fk on app.orders
 trigger              | {app,users,users_when}       | {}          | users_when on app.users
 view                 | {app,v_users}                | {}          | app.v_users
 view                 | {app,v_users_star}           | {}          | app.v_users_star
 view                 | {app,v_over_view}            | {}          | app.v_over_view
```

Limits of this query, found while checking it:

- It needs two exclusions that look odd but are required: a column of a table already in the closure (otherwise the target table's own identity sequence and generated column show up), and an edge from an object to its own sub-object (a partitioned table's key column is `i` on the table, which wrongly cleared the table as a blocker until excluded).
- It does not follow inheritance. `DROP COLUMN name` on `app.users` also recurses into `app.child_users` in `ALTER TABLE` code, and Postgres reported `column name_upper of table app.child_users depends on column name`. That recursion goes through `pg_inherits`, not `pg_depend`, so the query missed this one object (7 of 8 reported).
- It computes one action's blockers. The migration's statements run in order; a blocker that an earlier statement already removed is not a blocker. The scan needs the planned actions in `order(actions)` order, with the objects dropped so far added to the targets.
- It does not model `CASCADE`-free `ALTER` paths that rebuild objects (below).

## `ALTER COLUMN ... TYPE`

The retype check is not the `DROP` walk. [`RememberAllDependentForRebuilding`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/tablecmds.c) (about line 15079 in `tablecmds.c`) scans `pg_depend` for rows whose referenced object is the column (`refobjsubid = attnum`) and switches on the dependent's catalog:

| Dependent catalog                                     | Result for a retype                                            |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| index, constraint, extended statistics                | rebuilt, not a blocker                                         |
| sequence (SERIAL)                                     | ignored                                                        |
| `pg_rewrite` (view, materialized view)                | `0A000` "cannot alter type of a column used by a view or rule" |
| `pg_proc` (`BEGIN ATOMIC` function)                   | `0A000` "... used by a function or procedure"                  |
| `pg_trigger`                                          | `0A000` "... used in a trigger definition"                     |
| `pg_policy`                                           | `0A000` "... used in a policy definition"                      |
| `pg_attrdef` of another column (generated expression) | `0A000` "... used by a generated column"                       |
| `pg_publication_rel`                                  | `0A000` "... used by a publication WHERE clause"               |
| anything else                                         | `elog(ERROR, "unexpected object depending on column ...")`     |

Each `ereport` fires inside the loop, so the first row in index-scan order ends the check. The retype of `email` had five blockers (a policy, a publication, two views, a trigger) and Postgres named `rule _RETURN on view app.v_users`. The code takes whichever matching row the index scan returns first and does not sort them, so which blocker is named is not defined by the catalog contents alone.

`ALTER COLUMN ... SET EXPRESSION` runs the same function with the function, view, trigger, policy, and publication cases skipped ("This is only a problem for AT_AlterColumnType"), so a view over a generated column does not block a new expression (verified).

A whole-row view reference (`select w from w`) is recorded on the table (`objsubid 0`), not on a column, so it does not block a retype or a column drop (verified).

### Working SQL: blockers of a retype

```sql
prepare retype_blockers(oid, int) as
select a.type, a.object_names, a.object_args, d.deptype
  from pg_depend d
  cross join lateral pg_identify_object_as_address(d.classid, d.objid, d.objsubid) a
 where d.refclassid = 'pg_class'::regclass and d.refobjid = $1 and d.refobjsubid = $2
   and d.classid in ('pg_rewrite'::regclass, 'pg_proc'::regclass, 'pg_trigger'::regclass,
                     'pg_policy'::regclass, 'pg_publication_rel'::regclass, 'pg_attrdef'::regclass)
   -- the column's own default is not a blocker
   and not (d.classid = 'pg_attrdef'::regclass
            and (select (adrelid, adnum) = ($1, $2) from pg_attrdef where oid = d.objid))
 order by 1, 2::text;
```

`execute retype_blockers('app.users'::regclass, <attnum of email>)` returned the five objects above. For `name` it returned six, led by the generated column `name_upper` (`default value`, `{app,users,name_upper}`). Postgres, for the same retype, named only the generated column.

## Mapping rows to names and catalog keys

| Function                                                                                                 | Output                                                                                                            | Fit                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`pg_describe_object(classid, objid, objsubid)`](https://www.postgresql.org/docs/18/functions-info.html) | text such as `view app.v_users` or `column email of table app.users`. Docs: human-readable, "might be translated" | Messages shown to a person                                   |
| [`pg_identify_object(...)`](https://www.postgresql.org/docs/18/functions-info.html)                      | `type`, `schema`, `name`, `identity`. Docs: "machine-readable, and is never translated"                           | Stable text; `name` is null when the name alone is ambiguous |
| [`pg_identify_object_as_address(...)`](https://www.postgresql.org/docs/18/functions-info.html)           | `type`, `object_names text[]`, `object_args text[]`; docs: independent of the server                              | Structured; usable as a key                                  |

`object_names` for the modeled kinds matches the catalog key segments (`docs/architecture.md`, Catalog): `table` gives `{app,users}`, `table column` gives `{app,users,email}`, `table constraint` gives `{app,users,users_email_key}`, `schema` gives `{app}`. The catalog joins segments with `\0` and puts an empty segment before a constraint name, so a constraint key is `app\0users\0\0users_email_key`; the scan has to add that empty segment when `type` is `table constraint`. `pg_identify_object`'s `identity` shows the same constraint as `users_email_key on app.users`.

For Unmodeled blockers, `type` plus `object_names` is the readable name. Examples: `trigger {app,users,users_when}`, `rule {app,v_users,_RETURN}`, `function {app,f_atomic} {integer}`, `publication relation {app,users} {pub_users}`. The `rule _RETURN` entry is a view in practice; the closure walk reports the owning view, whose `type` is `view`, `materialized view`, or `table` (`pg_identify_object` distinguishes the relkind).

Per the docs, `pg_describe_object` and `pg_identify_object` return `NULL` for an undefined object.

Two text caveats for today's path: the `2BP01` `DETAIL` uses `_()` translation and `getObjectDescription`, so its wording follows `lc_messages` and schema qualification follows `search_path` (the fixture showed `app.users` qualified because `app` was not on the path; the repo's test shows `users` unqualified for `public`). `explainShadowError` forwards the lines as they come.

## What verification reports today

Source: `src/dev/generate/shadow-errors.ts`, `verify.ts`, and `verify.test.ts`; ADR-0013.

- **`2BP01` on a drop: every non-auto dependent of that one statement, transitive.** [`reportDependentObjects`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/dependency.c) walks the whole closure and appends each refusing object to `DETAIL`. The text `X depends on Y` can name an intermediate object as `Y` (`view v_over_view depends on view v_users`). The client sees at most 100 entries; the constant is `MAX_REPORTED_DEPS 100`, "since client software may not deal well with enormous error strings". Past that the `DETAIL` ends `and N other objects (see server log for list)` (verified with 120 views: 100 lines plus the count). The full list goes to the server log only.
- **Message form:** a single-target drop says `cannot drop <object> because other objects depend on it`; `ALTER TABLE ... DROP COLUMN` and other multi-target drops say `cannot drop desired object(s) because other objects depend on them`. Both carry `2BP01`, and `explainShadowError` maps both by code.
- **`0A000` on a retype: one object.** `explainShadowError` maps only the message that starts "cannot alter type of a column used by a view". The function, trigger, policy, generated-column, and publication variants (same SQLSTATE) pass through without the hand-edit hint.
- **One failing statement per run.** `verifyInShadow` calls `shadow.execute(sql)` with the whole body. A multi-statement body runs as one simple query: `alter table ... drop column email; alter table ... drop column id; ...` failed on the first statement and reported only its seven blockers (verified). The second statement's blockers appear only after the user fixes the first and re-runs `generate`. A scan over the planned actions would report blockers for all statements in one run.
- **`2BP01` also fires for objects the generated SQL never touches.** `drop role` on a role with a grant raised `2BP01` (verified; it comes from `pg_shdepend`), which the mapping would label an Unmodeled blocker. Generated SQL never drops a role, so this only matters for a hand edit.
- **Hand edits:** a hand-edited `current.sql` is verified instead of the generated SQL (`leftoverAfter`, `handEdited: true`). Its statements are not the diff's actions, so a scan driven by the diff's actions does not cover a hand edit.
- **Verification reports no blocker that exists only outside the Shadow.** It runs in the Shadow built from the Committed migrations, so it sees only objects those migrations create (ADR-0011, ADR-0013).

## What Postgres records no dependency for

| Gap                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function bodies written as a string (`LANGUAGE sql 'select ...'`, PL/pgSQL)                                    | [Dependency tracking](https://www.postgresql.org/docs/18/ddl-depend.html): only "externally visible properties" such as argument and result types are tracked. Fixture: `f_string` and `f_plpgsql` have no `pg_depend` row on any table or column; the table `DROP` and column `DROP`s all succeeded around them. |
| `BEGIN ATOMIC` bodies                                                                                          | Tracked (same page). `f_atomic` has `n` rows on `users.id` and `users.name`, and blocks drops and retypes.                                                                                                                                                                                                        |
| Dependencies on pinned (built-in) objects: built-in types, `now()`, operators                                  | [`pg_depend`](https://www.postgresql.org/docs/18/catalog-pg-depend.html) "Most objects created during initdb are considered pinned"; a scan cannot see a dependency on a built-in function.                                                                                                                       |
| Inheritance and partition recursion of `ALTER TABLE`                                                           | `pg_depend` has one `n` row from the child table to the parent table and none per column; the column link is in `pg_inherits` (fixture).                                                                                                                                                                          |
| Comments, privileges                                                                                           | `pg_depend` held no `pg_description` rows. ACL roles go to `pg_shdepend`.                                                                                                                                                                                                                                         |
| Anything that reads an object by name at run time (dynamic SQL, `search_path`-dependent references, `EXECUTE`) | Follows from the string-body rule; not separately tested.                                                                                                                                                                                                                                                         |

ADR-0013 already records the function-body case. A scan would not change it: both a scan and verification pass a hand-written function that reads a dropped column and break when it runs.

## `pg_shdepend`

[`pg_shdepend`](https://www.postgresql.org/docs/18/catalog-pg-shdepend.html) records dependencies on shared objects. Referenced objects are only roles and tablespaces: "the current definition only supports roles and tablespaces as referenced objects". Deptypes: `o` owner, `a` ACL, `i` `pg_init_privs`, `r` policy target, `t` tablespace. It is one copy per cluster with a `dbid` column.

Facts for a scan:

- Modeled tables, columns, constraints, and types can only be on the dependent side. `pg_shdepend` cannot make a `DROP TABLE`, `DROP COLUMN`, or retype fail. In the fixture, `grant select on app.users to app_reader` added one `a` row, and `drop table app.users` ignored it. `drop role app_reader` failed with `2BP01` ("privileges for table app.users").
- A role that owns a table is a pinned bootstrap role (`postgres`) in the fixture and produced no `o` row; the docs say no rows are made for pinned objects.
- It matters only if a future change drops a role or tablespace, which the Definition cannot express.

## Where a scan could run

What each command has today (`docs/architecture.md`, `src/dev/generate/shadow-diff.ts`, `src/runtime/migrator`):

| Place                                                      | State there                                                                                                                                                                                                                                                                                                                                         | What a scan would have                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`, inside `diffInShadow`, before `verifyInShadow` | The Shadow holds the Committed migrations. `diff(...)` has just produced the actions. The Definition database and Shadow are both open on `Driver` ports.                                                                                                                                                                                           | The same Unmodeled objects verification sees, plus the diff's actions as targets (no SQL parsing). It reports every blocker of every action in one run, where verification reports one statement. It sees nothing verification cannot, because both read the Shadow.                               |
| `generate`, on a hand-edited `current.sql`                 | Targets are SQL statements, not actions.                                                                                                                                                                                                                                                                                                            | Nothing without parsing the edit or running it. `leftoverAfter` runs it today.                                                                                                                                                                                                                     |
| The Dev database                                           | Rebuilt by `resetDevDatabase` from the Committed migrations and the Current migration whenever the hash or tip changes, and only in a marked or empty Database (ADR-0016). Its Unmodeled objects are those the migrations create, plus anything added by hand since the last reset.                                                                 | Equal to the Shadow plus hand additions that the next reset removes. A scan here would differ from the Shadow only by those additions.                                                                                                                                                             |
| `commit`                                                   | Writes the next Committed migration file and the tracking row. It runs no migration SQL.                                                                                                                                                                                                                                                            | No database holding the target state, and no targets: the file holds SQL text and `-- hazard:` comments, not actions.                                                                                                                                                                              |
| `migrate` against another Database (staging, production)   | The runtime migrator runs each Committed file in its own transaction with its tracking row (`migrator`, ADR-0008). It is in the zero-dependency `runtime/`, takes a `Driver` and `MigrationSource`, and has no introspection. Unmodeled objects there can differ from the Shadow, since the Shadow holds only what the Committed migrations create. | Only place that can see a blocker the Shadow lacks. It has no actions, only file text. A statement that hits a blocker already fails with `2BP01` and rolls back its whole file, so nothing is half applied, but the error is not mapped to a message (`explainShadowError` is in `dev/generate`). |

Related facts:

- Postgres DDL is transactional, and `migrate` already wraps each file in a transaction. A failing statement rolls the whole file back. This is the existing way the production Database refuses a blocked change.
- The repo's introspect reads `pg_catalog` in one `REPEATABLE READ READ ONLY` transaction (`docs/architecture.md`, Pipeline), so a scan on the Shadow could read in the same transaction.

## What the scan would be made of

- The drop query above (about 40 lines of SQL), a retype query, a mapping from `type` + `object_names` to a modeled key or an Unmodeled name, and a per-action choice between the two walks.
- The retype table mirrors a `switch` in `tablecmds.c` with `FIXME someday` comments on five of its cases, so a later Postgres release can move a case. `docs/architecture.md` sets Postgres 18 and newer, with 19 in CI once released.
- The scan's list can disagree with Postgres in three known places: inheritance children, which retype blocker Postgres names, and statement ordering. Verification can't disagree with Postgres, since it is Postgres.

## Open questions for #380 "Unmodeled blockers show up only during verification"

1. What is the failure being fixed: reporting every blocker in one run instead of one statement per run, or reporting a blocker before any SQL runs? The scan changes the first; the Shadow already does the second (nothing touches the Dev database before verification passes).
2. Should the scan replace the `2BP01` mapping, or sit in front of it with verification as the backstop? A scan that disagrees with Postgres needs a rule for which one wins.
3. Is a blocker that a hand edit removes (the user's way out in ADR-0013) rescanned? The scan sees the generated actions, not the edit, so it needs the edit applied first or it reports blockers the edit already resolved.
4. Which actions get a scan: drops of tables, columns, constraints, and schemas (the drop walk), and type changes (the retype walk)? Set or drop default, identity, NOT NULL, and expression changes never blocked in the fixture.
5. Is a blocker a message only, or does generate stop? Today verification stops. A scan that lists several blockers still has to stop the run, since the Current migration would not apply.
6. Does `migrate` get a pre-check on a Database other than the Shadow database? That is the only place the scan sees something verification cannot, and it is in the zero-dependency runtime, which has no introspection and no actions.
7. Who names inheritance children and partitions: does the scan read `pg_inherits` too, or are inherited and partitioned tables out of scope until the Definition can express them?
8. Do v0.2's foreign keys (modeled) change the answer? A modeled foreign key makes `pg_constraint` `n` rows between modeled objects and puts ordering of drops back on the diff (`order(actions)` becomes a topological sort). Those dependents are modeled, so the scan would have to tell "Unmodeled" apart from "modeled and ordered by the diff" using the catalog.
9. How are non-English servers handled? `pg_describe_object` and the `2BP01` `DETAIL` follow `lc_messages`; `pg_identify_object*` does not. The existing mapping forwards translated lines.
10. Should the message distinguish a blocker the Definition could model later from one it never will (ADR-0005 says a warning can name the version that plans to support a kind)?

## Appendix

### A. Direct dependents of modeled objects

```sql
with modeled(refclassid, refobjid, refobjsubid, kind) as (
  select 'pg_class'::regclass, c.oid, 0, 'table'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname = 'app'
  union all
  select 'pg_class'::regclass, a.attrelid, a.attnum, 'column'
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname = 'app' and a.attnum > 0 and not a.attisdropped
  union all
  select 'pg_constraint'::regclass, k.oid, 0, 'constraint'
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
   where k.contype in ('p', 'u') and n.nspname = 'app'
)
select m.kind,
       pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) as referenced,
       d.deptype,
       d.classid::regclass as dep_catalog,
       pg_describe_object(d.classid, d.objid, d.objsubid) as dependent
  from modeled m
  join pg_depend d on d.refclassid = m.refclassid and d.refobjid = m.refobjid and d.refobjsubid = m.refobjsubid
 where d.deptype <> 'e'
 order by 2, 3, 5;
```

### B. Comparison with Postgres's own errors

Each row compares the scan with the `DETAIL` Postgres raised for the same statement on the fixture.

| Statement                                               | Postgres reported                       | Scan returned                                         |
| ------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `drop table app.users`                                  | 9 objects                               | the same 9                                            |
| `alter table app.users drop column email`               | 7                                       | the same 7                                            |
| `alter table app.users drop column id`                  | 7                                       | the same 7                                            |
| `alter table app.users drop column name`                | 8 (incl. the inheriting child's column) | 7 (misses the child's column; inheritance, see above) |
| `alter table app.users drop constraint users_email_key` | 1 (`orders_email_fk`)                   | the same 1                                            |
| `alter table app.users drop constraint users_pkey`      | 1 (`orders_user_fk`)                    | the same 1                                            |
| `drop schema app`                                       | 20                                      | the same 20                                           |
| `drop table app.plain`                                  | ok                                      | none                                                  |
| `drop table app.orders, app.users`                      | 7 (foreign keys no longer block)        | the same 7                                            |

Statements that did not block (rolled back, `OK`): `alter column email drop not null`, `alter column name drop default`, `alter column name_upper set expression as (lower(name))`, `alter column name set not null`, `alter column id drop identity`, `alter column id set generated by default`, `drop column orders.user_id`, `drop constraint orders_pkey`, `rename column`, `rename table`.

### C. Fixture

Schema `app`, modeled objects: `users` (identity primary key, unique `email`, `varchar(20)` default, `timestamptz` default `now()`, stored generated `name_upper`), `orders`, `plain`. Unmodeled objects on them: three views and a view over a view, a materialized view, two foreign keys (one to the primary key, one to the unique), an expression index, a `pg_trgm` GIN index, a CHECK, three triggers (plain, `WHEN`, `UPDATE OF`), an enabled row-level-security policy, four functions (string-bodied SQL, PL/pgSQL, `BEGIN ATOMIC`, taking the row type), extended statistics, a publication with a column list and `WHERE`, an inheritance child, a partitioned parent with one partition, a sequence `OWNED BY`, a rule, a domain, an enum, a role with a grant, a comment, and a default that calls a user function. Statements were tried inside a PL/pgSQL block that raises at the end, so each one rolled back.

### Sources

- [pg_depend](https://www.postgresql.org/docs/18/catalog-pg-depend.html), [pg_shdepend](https://www.postgresql.org/docs/18/catalog-pg-shdepend.html), [Dependency tracking](https://www.postgresql.org/docs/18/ddl-depend.html), [System information functions](https://www.postgresql.org/docs/18/functions-info.html) (PostgreSQL 18 documentation).
- [`dependency.c`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/dependency.c): `findDependentObjects`, `reportDependentObjects`, `MAX_REPORTED_DEPS`. [`dependency.h`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/catalog/dependency.h): `DependencyType`, `SharedDependencyType`. [`tablecmds.c`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/tablecmds.c): `RememberAllDependentForRebuilding`.
- Repo: `docs/adr/0013-diff-two-introspected-databases.md`, `docs/adr/0005-diff-ignores-unmodeled-objects.md`, `docs/architecture.md` (Diff engine, Catalog), `GLOSSARY.md`, `src/dev/generate/shadow-errors.ts`, `src/dev/generate/verify.ts`, `src/dev/generate/shadow-diff.ts`.
