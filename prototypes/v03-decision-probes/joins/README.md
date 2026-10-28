# Prototype: join shape

Throwaway probe for #658 (map #652, probes #672). Question: does the decided join shape (`innerJoin(t, on)` and `leftJoin(t, on)`, positional refs, column operands, nullable left-joined refs, SQL-name aliases) type and run as claimed, and at what cost?

## Verdict

Mostly keep. The shape types, runs, and costs little: each join adds about 450 instantiations to a query. Three amendments:

| Sub-decision                                                                 | Verdict                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `innerJoin` and `leftJoin`, `on` required                                    | **Keep.** A missing `on` prints `Expected 2 arguments, but got 1.`                                                                                                                                                                                                      |
| Positional refs, self-join with no alias                                     | **Keep.** Named refs cost the same and add an alias argument. A later table needs placeholders (`(_u, _p, c) =>`).                                                                                                                                                      |
| Operand: a value or a ColumnRef "of the same non-null type"                  | **Amend** twice. (1) Type it as any column with that non-null type, nullable or not; `ColumnRef<NonNullable<V>>` taken literally refuses every nullable and every left-joined column. (2) Match columns by SQL type class, not by TypeScript type (see Postgres facts). |
| Left-joined refs turn `ColumnRef<V \| null>`, a NULL skips the decoder       | **Keep**, and state that `on` sees the joined table as declared. Only later callbacks see it nullable.                                                                                                                                                                  |
| Query only after `select`; `pick` hidden; joins dropped after `select`       | **Keep.** Each misuse fails to compile, and a JS caller gets a named runtime error.                                                                                                                                                                                     |
| Alias by SQL name, `_2`, `_3`, skipping names in use; single-table SQL as is | **Amend:** cut the name so name plus suffix fits in 63 bytes. Postgres truncates `<63-byte name>_2` back to the name.                                                                                                                                                   |
| Codecs, `casing`, `.name()` per table                                        | **Keep.** Ran on Postgres.                                                                                                                                                                                                                                              |
| Names stay `string` (#312)                                                   | **Keep**, with a different reason: literal keys cost 148 instantiations project-wide, so cost isn't the argument. Positional refs just don't need them.                                                                                                                 |
| One `join(t, on, "left")`                                                    | **Reject.** Same cost. The kind trails the callback, so the nullability change hides in an optional third argument.                                                                                                                                                     |

## What changed

- `query/probe-joins-types.ts` holds the decided types. `Joined = [Table, nullable]` is one FROM entry, and `RefsOf<J>` maps the entry tuple to one callback parameter each. `JoinRef<V>` has six comparisons with operand `V | ColumnOperand<V>`, where `ColumnOperand<V> = Selectable<V | null>`. The union is a single parameter, not an overload. `FromQuery<T>` (single table, with a `pick` stub), `JoinedBuilder<J>` (no `toSql`, no `pick`), and `SelectedQuery<J, R>` (no joins) are the three builder states.
- `query/probe-joins.ts` is the runtime. Refs are registered in a `WeakMap`, so `eq` can tell a column operand from a jsonb value. A column operand renders its identifier and skips codecs. `where`, `orderBy`, and `on` callbacks run at `toSql`, so a `where` written before a join still renders qualified. `select` runs at once. Each output keeps its table position, and decoders compose per table through the existing `decoderFor`.
- `query/probe-joins-alt.ts` holds alternatives A (named refs, `fromNamed({ u: users }).innerJoin({ p: posts }, ({ u, p }) => …)`) and C (`join(t, on, kind?)`), both running on the decided runtime.
- `query/probe-joins-class.ts` and a 10th `Sql` type parameter on `Column` (`definition/column.ts`, `definition/factories.ts`) make alternative D: an operand must share the column's SQL type class. This is the second commit, and the parent can drop it.
- Tests: `probe-joins.test.ts` (decided shape), `probe-joins-gaps.test.ts` (what the decided shape compiles but Postgres refuses), `probe-joins-alt.test.ts`, `probe-joins-class.test.ts`.

## Postgres facts the types encode

PostgreSQL 18.6, `select 1 from t t1 join t t2 on t1.a = t2.b`:

| Left = right                            | TS types          | Postgres                             | Decided shape | Alt D          |
| --------------------------------------- | ----------------- | ------------------------------------ | ------------- | -------------- |
| uuid = text                             | string = string   | operator does not exist: uuid = text | compiles      | refuses        |
| uuid = numeric, uuid = date             | string = string   | operator does not exist              | compiles      | refuses        |
| text = numeric, text = date             | string = string   | operator does not exist              | compiles      | refuses        |
| text = enum                             | string = "a"\|"b" | operator does not exist              | compiles      | refuses        |
| enum = another enum                     | "a"\|"b" both     | operator does not exist              | compiles      | compiles (gap) |
| text = varchar, text = domain over text | string            | ok                                   | compiles      | compiles       |
| integer = bigint                        | number = bigint   | ok                                   | refuses       | compiles       |
| integer = numeric                       | number = string   | ok                                   | refuses       | compiles       |
| date = timestamptz                      | string = Date     | ok                                   | refuses       | compiles       |
| text[] = integer[]                      | arrays differ     | operator does not exist              | refuses       | refuses        |
| jsonb = jsonb, bytea = bytea            | same              | ok                                   | compiles      | compiles       |

The decided rule keys on the TypeScript value type, which is the wrong key in both directions. Several SQL types read `string`, and a codec changes the TS type without changing the SQL type. A value operand never hit this, because Postgres types a param from the column it meets.

Also checked:

- A self-join of a table whose name is 63 bytes, aliased `<name>_2`, fails: `table name "ttt…t" specified more than once`. Postgres truncates identifiers to 63 bytes. `probe-joins-gaps.test.ts` pins both failures.
- A self-join three deep (`users`, `users_2`, `users_3`) and a three-table inner-plus-left join run under `casing: "snake_case"` and a `.name("Body")` column. They return per-table codec values, and `null` where a left join found no row.

## Error texts (tsc 7, `--pretty false`)

A missing `on`: `error TS2554: Expected 2 arguments, but got 1.`

A uuid column against an integer column (names the operand by its type, no wall):

```
error TS2345: Argument of type 'JoinRef<number | null>' is not assignable to parameter of type 'string | ColumnOperand<string>'.
  Type 'JoinRef<number | null>' is not assignable to type 'ColumnOperand<string>'.
    Types of property '"~value"' are incompatible.
      Type 'number | null' is not assignable to type 'string | null'.
```

With `"~value"` optional, as in `from.ts`'s `SelectableColumn`, the same error adds a misleading `Consider adding 'undefined' to the types of the target's properties` hint (exactOptionalPropertyTypes). The probe makes the brand required. The literal-reading operand (`string | JoinRef<string>`) refuses a nullable column with `Type 'string | null' is not assignable to type 'string'`.

`eq(null)`: `Argument of type 'null' is not assignable to parameter of type 'number | ColumnOperand<number>'.`

`isNull()` in a left join's `on`, on a NOT NULL column: `Property 'isNull' does not exist on type 'JoinRef<number>'.`

A third callback parameter after one join (wall):

```
error TS2345: Argument of type '(u: any, _p: any, x: any) => any' is not assignable to parameter of type '(refs_0: TableRefs<Table<{ id: Column<string, true, …>; … }, "id">, false>, refs_1: TableRefs<...>) => Predicate'.
  Target signature provides too few arguments. Expected 3 or more, but got 2.
```

A joined builder without `select` passed to `client.all` (wall first, and no hint to call `select`):

```
error TS2345: Argument of type 'JoinedBuilder<[[Table<{ id: Column<string, true, …>; … }, "id">, false], [...]]>' is not assignable to parameter of type 'Query<unknown>'.
  Property 'toSql' is missing in type 'JoinedBuilder<…>' but required in type 'Statement'.
```

`pick` after a join, and `innerJoin` after `select`, name the method first and then print the wall: `Property 'pick' does not exist on type 'JoinedBuilder<[[Table<{ … `, `Property 'innerJoin' does not exist on type 'SelectedQuery<[[Table<{ … `.

A non-column in `select`: `Type 'number' is not assignable to type 'Selectable<unknown>'.`

Alternative D, uuid against text (names both SQL classes):

```
error TS2345: Argument of type 'ClassRef<string | null, "text">' is not assignable to parameter of type 'string | ClassOperand<"uuid">'.
  …
        Type '"text"' is not assignable to type '"uuid"'.
```

Alternative A, an alias already in use: `… is not assignable to parameter of type '{ readonly u: Table<…> } & { readonly "u is already in use": never; }'. Property '"u is already in use"' is missing …`. An unknown alias: `Property 'q' does not exist on type 'NamedRefs<With<{ readonly u: readonly [Table<{ … `.

Alternative C, a bad kind: `Argument of type '"right"' is not assignable to parameter of type '"inner" | "left" | undefined'.`

## Cost

`pnpm exec tsc --noEmit --extendedDiagnostics`, median of three:

| State                                   | Types   | Instantiations | Check time |
| --------------------------------------- | ------- | -------------- | ---------- |
| `main`                                  | 182,634 | 393,459        | 0.213 s    |
| Decided shape + A + C, no probe tests   | 184,270 | 394,864        | 0.214 s    |
| Decided shape + A + C, with probe tests | 188,643 | 411,011        | 0.211 s    |
| Plus D (`Sql` on Column), no tests      | 196,980 | 458,410        | 0.224 s    |
| Plus D, with tests                      | 201,978 | 476,983        | 0.225 s    |

D's 10th parameter costs +16% instantiations as committed, where factories return a `Fresh<V, Sql, Int>` alias. Written inline it cost +7.4% (424,499 against 395,146), but the inline form fails the fta score check (63.4 against 60). Check time doesn't move.

Join count, one query added to the tree without probe tests (baseline 395,146 instantiations). Each join alternates left and inner, `on` compares two columns, and `where` and `select` touch every table:

| Joins | Positional, 1 query | Named (A), 1 query | Positional, 10 queries | Named (A), 10 queries |
| ----- | ------------------- | ------------------ | ---------------------- | --------------------- |
| 1     | +1,537              | +1,460             | +2,383                 | +1,973                |
| 2     | +1,947              | +1,847             | +3,459                 | +2,729                |
| 3     | +2,399              | +2,460             | +4,757                 | +3,801                |
| 4     | +2,874              | +2,874             | +6,258                 | +4,764                |

Growth is linear, at about 450 instantiations per join, with no cost surprise. Literal table keys (`Table & { "~key": Name }` in `Database<S>`, the cheapest literal name for #312) added 81 types and 148 instantiations project-wide.

`pnpm test`: 284 files, 3080 tests pass (main: 280 files; the probe adds 4 files, 25 tests). `tsc` is clean. Lint, format, and fta pass after two refactors: types split from runtime, and the alternative tests moved to their own files.

## Open for the real design

- D leaves gaps: two enums with the same labels share a class, and so does an enum against one with a subset of its labels. Closing them needs the enum's name as a literal, which reopens #312 for enums only. Domains are lenient both ways, because `Domain<V, N>` doesn't carry its base type. A cheaper fallback is a build-time runtime check on `state.sqlType` and enum identity: it names both columns, but at run time.
- The decision allows `where` before a join. Then predicates must render with the final aliases: either defer callbacks to `toSql`, as here, so a throwing callback throws there, or give `Predicate` a render context. Forbidding `where` before joins removes the question.
- `client.all(joinedBuilder)` opens with a `JoinedBuilder<[[Table<…` wall. A type-only `"~returns": "call select() first"` brand could put the fix in the message (untested).
- `orderBy` is a stub (bare columns). #655's `nulls` option would appear on left-joined refs, since they turn nullable.
- A name two tables share needs no rule: `select` keys are object keys, so a duplicate is already TS1117.
