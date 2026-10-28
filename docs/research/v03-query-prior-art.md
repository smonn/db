# Prior art for v0.3 query statements

Research for #653, a child of #652 (plan v0.3). It covers update, delete, joins, upsert, placeholders, and the name-list `select`, in Drizzle, Kysely, Zapatos, and Slonik. Findings are framed against this repo's builder: `from` and `insert`, column objects, `select`/`returning` taking an object callback (ADR-0004), and statements as values run by a client (ADR-0012).

## Sources and method

- Versions probed: drizzle-orm 0.45.4, kysely 0.29.7, zapatos 6.6.1, slonik 49.12.0, TypeScript 7.0.2, installed on 2026-10-27 in a scratch folder.
- "Typed" claims marked **(tsc)** come from a compile of a small probe against the installed package: the quoted text is tsc's output. Probe files lived in the session scratchpad and are not in the repo.
- "Source" claims quote the tip of each project's default branch, fetched the same day (`drizzle-team/drizzle-orm` main, `kysely-org/kysely` master). They may differ from the installed version.
- Docs: orm.drizzle.team (update, delete, joins, insert, perf-queries), jawj.github.io/zapatos, the Slonik README.
- The repo's own error text comes from a tsc probe against `src/runtime/query` at `27e66d9`.
- Not run: any query against a database. Postgres behavior (error messages for a table named twice, `on conflict` rules) is out of scope here; the pg-facts note covers it.

## 1. Update and delete

|         | Missing `where`                                                                                    | Empty or `undefined` filter                                                                                                                                                                                | Result type                                                                                |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Drizzle | Compiles **(tsc)**. Docs show `db.delete(users)` and say "You can delete all rows in the table".   | `where(where: SQL \| undefined)` accepts `undefined`, which sets `config.where = undefined`: no filter.                                                                                                    | Count without `.returning()`; rows with it.                                                |
| Kysely  | `updateTable("person").set(...).execute()` and `deleteFrom("person").execute()` compile **(tsc)**. | n/a (no object filter)                                                                                                                                                                                     | `UpdateResult` without `returning`; `{ id: number; name: string }` rows with it **(tsc)**. |
| Zapatos | Impossible to omit: `where` is a required positional argument.                                     | `{}` is accepted and compiles to `TRUE`, so it matches every row (core.js: "or if it is empty, it should always match"). `select` accepts the explicit `all` marker; `update` and `delete` do not list it. | `JSONSelectable[]` of every affected row, always.                                          |
| Slonik  | No builder; a hand-written statement has no guard.                                                 | n/a                                                                                                                                                                                                        | Whatever the `sql.type` parser says.                                                       |

Signatures worth quoting:

- Zapatos: `update<T, C, E>(table: T, values: UpdatableForTable<T>, where: WhereableForTable<T> | SQLFragment<any>, options?: ReturningOptionsForTable<T, C, E>): SQLFragment<ReturningTypeForTable<T, C, E>[]>`.
- Drizzle `where(where: SQL | undefined): PgUpdateWithout<this, TDynamic, 'where'>`. The `Without` type drops `where` from the chain after one call, so a second `where` does not type-check (unless the query opts into `$dynamic()`, which I did not read). ADR-0004 chose the opposite (repeated `where` combine with `and`).

Drizzle's `set` guard:

- Undefined values are dropped before building (`mapUpdateSet` filters `value !== undefined`; docs: "Values of `undefined` are ignored in the object").
- A `set` left with no keys throws at build time: `No values to set` (utils.ts).
- `set({ nope: "x" })` and `set({ name: 1 })` fail **(tsc)**: `Object literal may only specify known properties, and 'nope' does not exist in type ...` and `Type 'number' is not assignable to type 'string | PgColumn<...> | SQL<unknown> | undefined'`.
- Kysely: `set({ nope: "x" })` fails with `'nope' does not exist in type 'UpdateObjectExpression<DB, "person", "person">'`; `set({ name: 1 })` fails with `Type 'number' is not assignable to type 'ValueExpression<DB, "person", string> | undefined'` **(tsc)**.

Neither Drizzle nor Kysely guards a missing `where` at the type level. Zapatos guards by position only, and `{}` defeats it. Nobody in this set has a typed "all rows" opt-in for update or delete. Zapatos's `all` is the nearest, and only for `select`.

`update ... from` (joined update):

- Drizzle: `db.update(users).set({ cityId: cities.id }).from(cities).where(and(eq(cities.name, 'Seattle'), eq(users.name, 'John')))`, with `alias(cities, 'c')` for a second use.
- Kysely: `updateTable("person").from("pet").set((eb) => ({ name: eb.ref("pet.name") })).whereRef("pet.owner_id", "=", "person.id")` compiles **(tsc)**.
- Both take the joined table into scope for the later `where` and `set` callbacks. Drizzle can also return joined-table columns: `.returning({ id: users.id, cityName: cities.name })` (docs).

Update and delete `returning`: Drizzle `.returning({ deletedId: users.id })` is typed `{ deletedId: number | null }[]` in the docs example. Kysely and Zapatos take a column list. The repo's `returning` already takes an object callback; the shape carries over.

## 2. Joins

### Nullable side

- Drizzle: a type-level map `AppendToNullabilityMap<TJoinsNotNull, TJoinedName, TJoinType>`. Left makes the new table `'nullable'`; right makes every earlier table nullable and the new one `'not-null'`; inner and cross add `'not-null'`; full makes every table nullable (qbsel `select.types.ts`).
  - Default select nests per table and nulls the whole object: `{ person: {...}; pet: { id: number; ownerId: number; name: string } | null }` **(tsc)**.
  - A flat partial select nulls the picked column: `{ name: string; petName: string | null }` **(tsc)**.
  - Docs: the nested form "will make whole object nullable instead of making all table fields nullable!"
- Kysely: the joined table's columns go through `Nullable<R>` (`LeftJoinedDB`, `RightJoinedDB`, `OuterJoinedBuilderDB`). Right join nulls every earlier table; full nulls both.
  - Left join: `{ id: number; petName: string | null; name: string }` **(tsc)**.
  - Right join: `{ petn: string; pn: string | null }`. Full join: both `string | null` **(tsc)**.
- Zapatos: no join shortcut. It nests with `lateral` selects, so the nullable side is whatever the sub-select returns. The docs' author example notes "we can be 100% certain that we'll get back a row" for that one case; a nullable lateral side is not documented in the part of the page I read (the fetch covered 100000 of 164588 characters).
- Slonik: not applicable; the row type is the zod schema you write.

### Same table twice

- Drizzle: runtime error, not a type error. `innerJoin(person, ...)` on a query from `person` compiles **(tsc)**. At runtime `createJoin` throws `Alias "${tableName}" is already used in this query` (pg select.ts and update.ts). `alias(person, "parent")` fixes it, and the default select then nests by alias: `{ parent: {...}; person: {...} }` **(tsc)**.
- Kysely: `innerJoin("person", ...)` from `person` compiles **(tsc)**; the alias form is `innerJoin("person as parent", ...)`, and the result type uses the alias: `{ name: string; parentName: string }` **(tsc)**. I did not check what Postgres says to the unaliased form, and I could not find a type-level guard.
- Zapatos: needs the `alias` option, "resolving ambiguity for Postgres" (docs).

So no library catches an unaliased self-join in types. This builder could.

### Colliding output names

- Kysely: silent merge. `select(["person.name", "pet.name"])` types as `{ name: string }` **(tsc)**. With `leftJoin(...).selectAll()` the merged key takes the union with null, so `person.id` becomes `number | null` because `pet.id` is nullable: `{ id: number | null; name: string | null; owner_id: number | null; parent_id: number | null }` **(tsc)**. At runtime node-postgres builds one object per row, so the later column wins; I did not run that.
- Drizzle: collisions cannot occur in the default form, which nests by table or alias. In the flat form you name each key, so two columns cannot share one. The docs do not discuss collisions (they say only that Drizzle "delivers name-mapped results from the driver without changing the structure").
- Zapatos: results are JSON per lateral level, nested under a key you choose.
- This builder: `select`/`returning` keys already name the output (ADR-0004), so the Drizzle-flat shape applies unchanged. A join adds the question of what `columns` holds.

### A join's `on`

- Drizzle: `on` is an `SQL` built from column objects (`eq(pet.ownerId, person.id)`). A column from a table not in the query is not a type error: `db.select({ x: pet.name }).from(person)` compiles **(tsc)** and throws at build time: `Your "x" field references a column "pet"."name", but the table "pet" is not part of the query! Did you forget to join it?` (dialect.ts).
- Kysely: `on` takes string references checked against the tables in scope; the unqualified form `innerJoin("pet", "owner_id", "id")` compiled **(tsc)** in my probe (both names exist on exactly one table).

## 3. Upsert

|         | Conflict target                                                                                                                                                                            | Excluded reference                                                                                                                                                                                                                                                                                                                | `do nothing`                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Drizzle | `target: IndexColumn \| IndexColumn[]`. `target: pet.id` on a `person` insert compiles **(tsc)**: the type is not tied to the inserted table.                                              | Raw SQL only: `set: { name: sql\`excluded.name\` }`. `excluded.nope` compiles **(tsc)** and is not checked.                                                                                                                                                                                                                       | `onConflictDoNothing({ target?, where? })`; target is optional.               |
| Kysely  | `oc.column("id")`, `oc.columns([...])`, `oc.constraint(name)`. A wrong name fails: `Argument of type '"nope"' is not assignable to parameter of type 'AnyColumn<DB, "person">'` **(tsc)**. | Typed. `OnConflictUpdateDatabase<DB, TB> = { [K in keyof DB \| 'excluded']: Updateable<K extends keyof DB ? DB[K] : DB[TB]> }`. `eb.ref("excluded.name")` checks; `"excluded.nope"` fails: `not assignable to parameter of type 'StringReference<OnConflictUpdateDatabase<DB, "person">, OnConflictTables<"person">>'` **(tsc)**. | `oc.column("id").doNothing()` and `oc.doNothing()`; result is `InsertResult`. |
| Zapatos | `Constraint<T> \| ColumnForTable<T> \| ColumnForTable<T>[]`; the constraint type is `UniqueIndexForTable<T>`, so only unique indexes qualify.                                              | Implicit: updates use `EXCLUDED.col`; `noNullUpdateColumns` swaps in `CASE WHEN EXCLUDED.c IS NULL THEN table.c ELSE EXCLUDED.c END`.                                                                                                                                                                                             | `updateColumns: db.doNothing` (an alias for `[]`).                            |
| Slonik  | Hand-written SQL.                                                                                                                                                                          | Hand-written.                                                                                                                                                                                                                                                                                                                     | Hand-written.                                                                 |

More detail:

- Drizzle upsert has `targetWhere` (partial-index target) and `setWhere`, both raw `sql`. The old `where` is deprecated and throws if combined with either: `You cannot use both "where" and "targetWhere"/"setWhere" at the same time - "where" is deprecated, use "targetWhere" or "setWhere" instead.` Drizzle's `set` reuses the update `set` type, so it type-checks keys and values against the table (`set: { nope: "x" }` fails **(tsc)**).
- Drizzle `onConflictDoNothing` and `onConflictDoUpdate` are mutually exclusive in the chain (`PgInsertWithout<..., 'onConflictDoNothing' | 'onConflictDoUpdate'>`).
- Kysely `doUpdateSet` takes an object whose values may be `eb.ref("excluded.x")`; `doUpdateSet({ name: 1 })` fails with `Type 'number' is not assignable to type 'ValueExpression<OnConflictUpdateDatabase<DB, "person">, OnConflictTables<"person">, string | undefined>'` **(tsc)**.
- Kysely's callback form of `doUpdateSet` rejected a mismatched return type with a long, hard-to-read message (the `isSelectQueryBuilder` property is "missing"), which is the unhelpful shape ADR-0004 warned about.
- Zapatos reports which branch ran. By default the row gains `$action: 'INSERT' | 'UPDATE'`; `reportAction: 'suppress'` removes it. With `updateColumns: doNothing` the result type adds `undefined`, since `do nothing` returns no row for a conflict (`UC extends never[] ? undefined : never`).
- None of the four checks that the conflict target has a unique index in Postgres. Zapatos is the only one that types it, from a generated schema that lists unique indexes. This repo's tables model `.unique()`, multi-column `unique`, and `primaryKey` (ADR-0010, ADR-0021), so a typed target looks possible; I did not check how those reach the type level.

## 4. Placeholders

|         | How a value is deferred                                                                                                                                                                                                                        | When a missing value is caught                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle | `sql.placeholder("id")` inside the query; bound with `prepared.execute({ id: 10 })`.                                                                                                                                                           | Runtime, in `fillPlaceholders`: `No value for placeholder "${p.name}" was provided`. Types do not help: `p.execute({ nope: 1 })`, `p.execute({ id: "not a number" })`, and `p.execute()` all compile **(tsc)**. The docs do not mention the missing case. |
| Kysely  | None found. `compile()` returns `CompiledQuery<Row>` with positional `parameters` **(tsc)**; I found no named-placeholder API in the type surface.                                                                                             | n/a                                                                                                                                                                                                                                                       |
| Zapatos | None named. `param(x)` compiles to `$1`, `$2`, ...; `.prepared(name?)` names a server-side prepared statement.                                                                                                                                 | n/a                                                                                                                                                                                                                                                       |
| Slonik  | None named. The README: "There is no other way of passing parameters to the query"; values are `${}` template holes. `sql.prepared(name, parser)` names a prepared statement, but values are inline (`WHERE id = ${1}`), re-supplied per call. | n/a                                                                                                                                                                                                                                                       |

- Drizzle's placeholder is untyped on both ends: the placeholder's value type is `any`, and `execute` takes `Record<string, unknown>`. It also couples placeholders to prepared statements, which is a Postgres-side concept.
- ADR-0012 left `client.all(q, { minAge: 18 })` open. Nobody here types the values object from the placeholders used in the statement. That is what this builder can offer that the others do not: a placeholder is a typed hole (name plus column type), the statement type records the set of names, and the client signature requires exactly that object.
- The postgres.js Driver sends `toSql()` text through `sql.unsafe` without preparing (ADR-0012), so a named placeholder here is client-side substitution into `$n` params. That differs from Drizzle, where `prepare()` and placeholders arrive together.

## 5. Name-list `select`

- Kysely, `select(["id", "nope"])` on `person` **(tsc)**:

  ```
  error TS2769: No overload matches this call.
    The last overload gave the following error.
      Argument of type 'string[]' is not assignable to parameter of type 'SelectExpression<DB, "person">'.
  ```

  The offending name does not appear: tsc widened the array to `string[]`. Single name `select("nope")`: same "No overload matches this call", ending `Argument of type '"nope"' is not assignable to parameter of type 'SelectExpression<DB, "person">'`. A wrong name inside the callback form, `eb.ref("nope")`, is a plain error: `Argument of type '"nope"' is not assignable to parameter of type 'StringReference<DB, "person">'`.

- So ADR-0004's claim holds, with a nuance. The single-name form names the bad column; the list form does not.
- The repo's own `insert` has the same problem today. Against `defineTable(... id: text notNull, email, name)` **(tsc)**:
  - `values({ id: "u1", nope: "x" })` and `values({ id: 1 })` both report `No overload matches this call. The last overload gave the following error. Object literal may only specify known properties, and 'id' does not exist in type 'readonly NewRow<Table<...>>[]'`. That message blames the array overload and names the wrong property in the first case (`id` exists; `nope` is the problem).
  - `values({ email: "x" })` (missing required `id`) reports `'email' does not exist in type 'readonly NewRow<...>[]'`. The real problem is the missing `id`.
  - Drizzle's `values({ id: 1, nope })` shows the same array-overload message (`'id' does not exist in type '{ id: ...; name: ...; }[]'`). Kysely's single `InsertExpression` parameter gives `Object literal may only specify known properties, and 'nope' does not exist in type 'InsertExpression<DB, "person">'`, and for a missing required column `Type '{ id: number; }' provides no match for the signature '(eb: ExpressionBuilder<DB, "person">): InsertObjectOrList<DB, "person">'`.
  - The `from(...).select((u) => ({ x: u.nope }))` callback form gives a readable message in the repo: `Property 'nope' does not exist on type 'Refs<...>'`.
- Cause in this repo: the two `values` overloads (one row, array of rows). Whichever signature tsc reports last gets blamed, and an overload set is also what a name-list `select` would add. A single signature taking `NewRow<T> | readonly NewRow<T>[]` loses the `Many` marker that keeps `client.one` off multi-row inserts, so any fix has to keep that.

## 6. What this means for the builder

- Missing `where` on update and delete is unguarded in Drizzle and Kysely; Zapatos requires the argument but `{}` matches every row. A required `where`, with an explicit "all rows" marker, is open ground.
- Drizzle's `Without`-typed chain allows one `where`; ADR-0004 allows several, combined with `and`. Update and delete would follow the ADR unless a new decision overrides it.
- Join nullability is solved in types by Drizzle and Kysely, in two shapes: nest per table with the whole object `| null` (Drizzle default), or null each picked column (Drizzle flat, Kysely). The keys-name-the-output rule in ADR-0004 already gives the flat shape.
- Kysely's merge of colliding keys, including the `number | null` widening on `selectAll`, is the failure to avoid.
- Conflict targets and `excluded` are typed well only in Kysely; Drizzle's are loose (any column; raw `excluded`).
- Placeholder values are untyped everywhere. A typed set of placeholder names is unclaimed.
- The overload-blame problem exists today in `insert`, and a name-list `select` would add a second instance.

## Open questions

### #655 order, limit, operators

- None of the four sources above cover `order by`, `limit`, or operator breadth beyond what I read, so this note gives no prior art for them. Which sources should that ticket read first? (Zapatos has `order`, `limit`, `offset` options and throws `Direction must be ASC/DESC,` / `Nulls must be FIRST/LAST/` on bad input at runtime, the only related fact I saw.)
- Does `limit` change what `client.one` accepts? `client.one` already throws unless exactly one row comes back (ADR-0012), and the `~many` marker is the type-level version for inserts.
- Does a join make operators span tables (`u.id.eq(p.ownerId)`)? `ColumnRef.eq` takes `NonNullable<V>`, a value, not a column.

### #656 name-list select and insert type errors (a prototype)

- Which text counts as good? Kysely's list form hides the bad name (`string[]`), and the repo's `insert` blames the array overload. The prototype needs a pass bar, such as "the error names the bad key".
- Can one `values` signature keep the `Many` marker? A conditional return type over `NewRow<T> | readonly NewRow<T>[]` is the candidate; the prototype should test it.
- Is a name-list `select` worth it, given that the callback form already reads well and the list form's error is the worst case? "Why now?" for the maintainer.
- Does a missing required column in `insert` get its own message? Neither Drizzle nor Kysely names it.

### #657 update and delete

- Required `where` with an explicit all-rows marker, or optional like Drizzle? Zapatos shows a required positional argument is not enough on its own, because `{}` matches everything.
- Does an empty `set` fail at build time (Drizzle: `No values to set`) or at the type level?
- Does `set` accept `undefined` as skip (Drizzle) or reject it? ADR-0004's `eq(null)` stance (nullable columns only) suggests a stricter answer, and `insert` already treats `undefined` as "use the default".
- Can `set` reference the column itself or other columns (`set({ n: u.n.add(1) })`), or only values? Drizzle and Kysely allow expressions; the repo has no column arithmetic yet.
- Do update and delete without `returning` stay `client.run` only, as insert does (ADR-0012)? And what are the `~many` rules for them: an update can touch many rows, so `client.one` must reject it unless `returning` plus a unique filter says otherwise.
- `update ... from` and delete `using`: part of #657 or of #658?

### #658 joins

- Per-table nested objects (Drizzle default) or flat keys-name-the-output (Drizzle partial, Kysely)? The flat form matches ADR-0004; the nested form types the nullable side with one `| null`.
- How does a second reference to a table get its alias, and can the builder reject an unaliased repeat in types? No library here does.
- Do the callback parameters become one per joined table (`(u, p) => ...`) or one object keyed by alias? This decides how the `Refs` of ADR-0004 scale.
- Where does the nullable side's `isNull()` live after a left join? Today only nullable columns have `isNull()`. A left-joined column is nullable, so it gets one; is that the intended behavior?
- Is `on` a `Predicate` like `where`, and may it compare two columns? Same open item as under #655.
- Does a join change `client.one`'s guarantees? It can multiply rows.

### #659 upsert

- Is the conflict target typed from the table's unique and primary-key columns (ADR-0021)? Kysely checks column names only, Zapatos types unique indexes, Drizzle accepts any column.
- How is `excluded` exposed: a second parameter of the `set` callback, a property on the column object, or an `excluded` ref set? Kysely types it as a pseudo-table; Drizzle leaves it raw SQL.
- Does `do nothing` return no row for the conflicting input, and how does `returning` say so? Zapatos adds `undefined` to the result type and an optional `$action`; neither is free in `client.one`.
- Is the partial-index target (`targetWhere`) in scope for v0.3?
- Update-on-conflict and plain update share `set`. Is it one type?

### #660 named placeholders

- Typed holes: should the statement type record the placeholder names and column types so `client.all(q, { minAge: 18 })` requires exactly them? No prior art does this; Drizzle is runtime-only (`No value for placeholder "x" was provided`).
- Do values pass through the column codec at bind time (ADR-0022), and does a missing value throw at `toSql()` or at `client.*`? `toSql()` currently takes no arguments, so the value must reach the client call.
- Does a placeholder stand only where a column comparison already has a type, or also in `insert` values and `set`?
- May one placeholder appear twice in a statement? Drizzle's `fillPlaceholders` fills each occurrence; the `$n` count would need a rule.
- Does the postgres.js Driver need `{ prepare: true }` for anything here (ADR-0012)? Drizzle ties the two; this repo does not have to.
