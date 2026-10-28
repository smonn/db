# Prototype: update and delete shapes

Throwaway probe for #657, with #656's inline-parameter rule (map #652, probe ticket #672). Question: do the decided `update(t).set({...}).where(...)` and `deleteFrom(t).where(...)` shapes make every misuse a compile error that names the bad input, at an acceptable cost?

## Verdict

The decided shapes work as specified, and the identity-mode change costs almost nothing (+0.5% instantiations). Two amendments improve the errors without adding a concept:

| Sub-decision                                                                                     | Verdict                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set` / `deleteFrom` return only `where` and `allRows()`, not a Statement                        | **Keep the shape; amend the type** to name the fix and take the row, not the Table (alt H). The decided error says `Property 'toSql' is missing in type 'NeedsWhere<Table<{ id: Column<number, true, true, "always", ...` and never says "call where". Alt H says `Property 'toSql' is missing in type 'DeleteNeedsWhereOrAllRows<{ id: number; email: string; name: string \| null; born: Day \| null; }>'`. |
| Repeated `where` combines with `and`                                                             | **Keep.** Renders `where ("email" = $3 and "id" > $4)`.                                                                                                                                                                                                                                                                                                                                                       |
| `returning` reuses insert's shape                                                                | **Keep.** The probe's `returningQuery` is insert's code; codecs decode `returning` outputs on both statements.                                                                                                                                                                                                                                                                                                |
| `client.run` without `returning`; `client.all`/`client.one` with it; `allRows()` carries `~many` | **Keep.** All five misuses fail. The `~many` error names the marker only on its fourth line, as insert's `values([...])` does today.                                                                                                                                                                                                                                                                          |
| `set` written inline                                                                             | **Keep.** Through an alias (alt C) the error prints `SetRow<Table<{ ... }>>`, which confirms #656.                                                                                                                                                                                                                                                                                                            |
| `identity()` carries its mode in the column type                                                 | **Keep.** +413 types, +1,852 instantiations, no measurable check time. Refusing only at run time (alt D) saves that and lets `set({ id: 5 })` compile.                                                                                                                                                                                                                                                        |
| An identity-always key is left out of `set`                                                      | **Amend to a message key (alt B2)**, because the decided error says `'id' does not exist`, which is false and gives no reason. B2 prints `'id' does not exist in type '{ ...; "id is generated always, so update can't set it"?: number; ... }'`.                                                                                                                                                             |
| Empty `set` throws; undefined values are skipped                                                 | **Keep.** Postgres has no empty `set` (`update f set where ...` is a syntax error).                                                                                                                                                                                                                                                                                                                           |
| Codecs encode `set` values when the statement renders                                            | **Keep.** A throwing codec rejects `client.run`, not the builder.                                                                                                                                                                                                                                                                                                                                             |

## What changed

- `definition/column.ts`: `Gen` widens from `boolean` to `Generated = boolean | Identity`. `default()` sets `true` and `identity(mode)` sets the mode, with `"by default"` as the default. `"~types"` gains `generated: Gen`. The `default`/`identity` methods hide on `Gen extends false` instead of showing on `Gen extends true`. Nothing else in the repo had to change.
- `query/probe-mutate.ts`, the decided shape: `update(t).set(values)` and `deleteFrom(t)` return `NeedsWhere<T>` (`where`, `allRows`). `where` returns `FilteredMutation<T>` (Statement, `where`, `returning`). `allRows()` returns `MutationStatement<T, Many>` (Statement, `returning`). `set` validates when called: an unknown key or an identity-always key throws by name, undefined is skipped, and an empty set throws. Values are encoded when the statement renders. A `toSql` hidden from the type throws `deleteFrom needs where() or allRows() before it runs` for a JavaScript caller.
- `query/probe-mutate-alt.ts`: the alternatives, typed over the same runtime.
  - A: `deleteWhere(t, where | allRows)` and `updateWhere(t, where | allRows).set(...)`.
  - B: the identity-always key typed `never`.
  - B2: the identity-always key renamed to a message.
  - C: the decided mapped type behind an alias.
  - D: no identity mode, refused only at run time.
  - E: `toSql` typed as a message object.
  - H: builder types over the row.
- `query/probe-mutate.test.ts`: 21 tests. Each valid shape runs on Postgres and checks its rows, and each misuse has a labeled `@ts-expect-error`.

Shared file edited: `src/runtime/definition/column.ts` only.

## Postgres facts the types encode

Checked on PostgreSQL 18.6 against the test database:

| Statement                                                  | Result                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `update f set id = 5` on `generated always as identity`    | ERROR: column "id" can only be updated to DEFAULT                                        |
| `update f set id = default` on the same column             | OK; not expressible in the probe (#661 fragments)                                        |
| `update f set d = 9` on `generated by default as identity` | OK                                                                                       |
| `update f set g = 3` on `generated always as (...) stored` | ERROR, the same message; the Definition has no generated columns, so nothing to type yet |
| `update f set where ...`                                   | syntax error, so an empty `set` must throw                                               |
| `update ... where <no match> returning id`                 | 0 rows, so `client.one` rejects: the not-found check works                               |

## Error texts (tsc 7, `--pretty false`)

Table under test: `id` integer identity always primary key, `email` text NOT NULL, `name` text, `born` date with a codec to `Day`.

### Not a Statement

Decided, `client.run(deleteFrom(users))` (M1); `client.run(update(users).set(...))` (M2) prints the same:

```
error TS2741: Property 'toSql' is missing in type 'NeedsWhere<Table<{ id: Column<number, true, true, "always", true, true, false, false, false>; email: Column<string, true, false, false, false, false, false, false, false>; name: Column<...>; born: Column<...>; }, "id">>' but required in type 'Statement'.
```

Alt H, the same call with the builder typed over the row and named for its fix:

```
error TS2741: Property 'toSql' is missing in type 'DeleteNeedsWhereOrAllRows<{ id: number; email: string; name: string | null; born: Day | null; }>' but required in type 'Statement'.
```

Alt E, `toSql` typed as a message (`deleteFromMessage`), still prints the wall on line 1:

```
error TS2345: Argument of type 'UpdateNeedsWhereOrAllRows<Table<{ id: Column<number, true, true, "always", ...>; ... }, "id">>' is not assignable to parameter of type 'Statement'.
  Types of property 'toSql' are incompatible.
    Type '{ readonly "call where() or allRows() before running this": never; }' is not assignable to type '() => RenderedSql'.
```

Alt A, `client.run(deleteWhere(users))`, which is the shortest:

```
error TS2554: Expected 2 arguments, but got 1.
  (pretty mode adds) An argument for 'where' was not provided.
```

Alt A still needs a not-runnable state for update: `client.run(updateWhere(users, w))` without `set` prints `Property 'toSql' is missing in type '{ set(values: {...}): MutationStatement<Table<{ id: Column<...` (A3).

### Client markers

`client.one(update(users).set(...).allRows().returning(...))` (M3); alt A (`allRows` sentinel) and alt H print the same:

```
error TS2345: Argument of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ id: ColumnRef<number>; }>; } & Many' is not assignable to parameter of type 'Statement & { ... } & { readonly "~many"?: never; }'.
  ...
    Types of property '"~many"' are incompatible.
      Type 'true' is not assignable to type 'never'.
```

`client.all(update(users).set(...).where(...))`, with no `returning` (M4); `client.one` (M5) prints the same against its own parameter:

```
error TS2345: Argument of type 'FilteredMutation<Table<{ id: Column<number, true, true, "always", ...>; ... }, "id">>' is not assignable to parameter of type 'Query<unknown>'.
  Property '"~row"' is missing in type 'FilteredMutation<Table<...>>' but required in type '{ readonly "~returns": "rows"; readonly "~row": unknown; }'.
```

Alt H shortens it to `Argument of type 'FilteredMutationOf<{ id: number; email: string; name: string | null; born: Day | null; }>' is not assignable to parameter of type 'Query<unknown>'`.

### set

| Misuse                 | Decided (inline)                                                                                                                                        | First line names the key?                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M6 unknown key         | `Object literal may only specify known properties, and 'nope' does not exist in type '{ email?: string; name?: string \| null; born?: Day \| null; }'.` | yes                                                                                                                          |
| M7 null on NOT NULL    | `Type 'null' is not assignable to type 'string'.`                                                                                                       | no; the squiggle sits on `email`, and pretty mode adds `The expected type comes from property 'email'`, as insert does today |
| M8 identity always     | `... and 'id' does not exist in type '{ email?: string; name?: string \| null; born?: Day \| null; }'.`                                                 | yes, with a false reason                                                                                                     |
| M9 wrong type          | `Type 'number' is not assignable to type 'string'.`                                                                                                     | as M7                                                                                                                        |
| M13 explicit undefined | `Argument of type '{ email: string; name: undefined; }' is not assignable ... with 'exactOptionalPropertyTypes: true'.`                                 | names `name` on line 2                                                                                                       |

Alternatives for M8:

- B (`never`): `Type 'number' is not assignable to type 'never'.` The text doesn't name the key or give a reason.
- B2 (message key): `Object literal may only specify known properties, and 'id' does not exist in type '{ born?: Day | null; email?: string; "id is generated always, so update can't set it"?: number; name?: string | null; }'.` The unknown-key error keeps the same shape (B3), and null on NOT NULL is unchanged (B4). The keys print sorted, because the key remap is no longer homomorphic.
- C (alias): `... 'id' does not exist in type 'SetRow<Table<{ id: Column<number, true, true, "always", ...>; ... }, "id">>'.`
- D (runtime only): compiles. `set({ id: 5 })` throws `update can't set "id" of "public"."users": it is generated always`.

## Weighing alt A (the where as a required argument)

Alt A has the fewest error lines for delete, but it loses on the first criterion. It adds no fewer concepts: `allRows` becomes an imported sentinel in place of a method, and update keeps a not-runnable state (`update(t, w)` without `set`). It also puts `where` before `set`, against ADR-0004's one call per SQL clause in SQL order, and its marker is a conditional over a generic `W`. Keep the decided shape.

## Cost

`pnpm exec tsc --noEmit --extendedDiagnostics`, median of three:

| Tree                             | Types           | Instantiations  | Check time |
| -------------------------------- | --------------- | --------------- | ---------- |
| `main`                           | 182,634         | 393,459         | 0.249 s    |
| identity mode only (`column.ts`) | 183,047 (+0.2%) | 395,311 (+0.5%) | 0.242 s    |
| + probe sources, no probe test   | 184,146 (+0.8%) | 395,854 (+0.6%) | 0.230 s    |
| + probe test (all alternatives)  | 186,241 (+2.0%) | 404,246 (+2.7%) | 0.256 s    |

Check time varies more between runs than between trees.

`pnpm test`: 281 files and 3076 tests pass, the probe's 21 included. `tsc` is clean.

Lint passes behind probe-only disables: one file-level comment in the test (`max-lines`, `unicorn/consistent-function-scoping`, and `no-unsafe-call`/`no-unsafe-return` for the H4 misuse) and `no-generated-empty-object-type` on alt C, whose alias is the point.

## Open for the real design

- Alt H changes more than update and delete: `SelectQuery<T, R>`, `InsertStatement<T>`, and `Refs<T>` print the same Table wall. A real version would type every builder over its row (or a flattened row) and name each not-runnable state for its fix. The probe measured H only together with the other alternatives.
- The `~many` error could name the problem in its first line by making the marker a message key (`"~many": "client.one can't take a statement that changes every row"`). That also touches insert's `valuesMany`, so it belongs with the #656 amendment.
- The hidden runtime `toSql` makes `sql`'s `isStatement` (`"toSql" in value`) treat a not-runnable builder as a statement, so interpolating one is refused as a statement. A runtime brand on real statements would separate the two.
- B2's message key is a real key: `set({ "id is generated always, so update can't set it": 5 })` compiles and then throws at run time as an unknown key.
- No error text for null on a NOT NULL column names the key in its first line, here or in insert. The squiggle and the related info do.
- Postgres allows `set id = default` on an identity-always column. Nothing in v0.3 needs it; #661's fragment-as-value question covers it.
