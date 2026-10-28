# Prototype: upsert conflict target types

Throwaway probe for #659 (map #652). Question: can `insert(t).values(row).onConflict((u) => [u.a, u.b]).doNothing()` check its target against the table's declared keys at compile time, in any column order?

## Verdict

Feasible now, at low cost. Every key the Definition declares reaches the table type, and a wrong target fails with a one-line message naming the set. Nothing needed a new TypeScript feature or an overload.

## What changed

- `TableDefinition` and `Table` take a third parameter, `U extends KeySet`, and a type-only `"~keys": U`. A `KeySet` is `readonly [columns, partial]`, where `columns` is a union of column keys. A union of names makes the check order-free. The tuple wrapper keeps two sets from merging into one union.
- `KeySetsOf<C, Args>` in `table-extras.ts` reads the sets from what `defineTable` already infers:
  - the primary key, single or composite (`KeyOf`);
  - each column whose `Key` flag is set (`.primaryKey()` or `.unique()`);
  - each `unique` entry;
  - each `indexes` entry with `unique: true` whose keys are all refs or `{ key: ref }`, with `partial` true when it has a `where`. An entry with an `sql` key adds no set.
- `Database<S>` passes `"~keys"` through to `Table`.
- `InsertStatement.onConflict<const G>(target: (u: ConflictRefs<T>) => G & TargetCheck<T, G>)` is a single signature. `ConflictRefs` hands out `{ "~column": K }`, because the query layer's `ColumnRef<V>` doesn't carry its column name in its type.
- When only a partial unique index matches the target, the clause offers just `.where(pred)`, and `.where` returns `doNothing`. Any other key offers just `doNothing`.

Files: `definition/table.ts`, `definition/table-extras.ts`, `definition/definition.ts`, `definition/database.ts`, `query/insert.ts`, and the new `query/on-conflict.test.ts`. Public types touched: `Table`, `TableDefinition` (new parameter, defaulted, so bare `Table` still means any table) and `InsertStatement` (new method). New exported types: `KeySet`, `KeySetsOf`, `ConflictRefs`, `ConflictAction`, `ConflictClause`.

## Postgres facts the types encode

Checked on PostgreSQL 18.6 against the test database:

| Target                                 | Result                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| `(b, a)` for `unique (a, b)`           | OK, order is free                                          |
| `(a, a, b)`                            | OK, duplicates are ignored                                 |
| `(c, d)` for a partial unique index    | ERROR: no unique or exclusion constraint matching          |
| `(d, c) where c is not null`           | OK                                                         |
| `(id) where id is not null` (full key) | OK; the type refuses this, which is stricter than Postgres |
| `(a)`, a subset of a key               | ERROR                                                      |
| `((lower(e)))`, an expression index    | OK; out of this prototype's scope                          |

## Error texts (tsc 7, `--pretty false`)

A non-key single column:

```
error TS2322: Type 'readonly [ConflictRef<"name">]' is not assignable to type 'readonly [ConflictRef<"name">] & { readonly "(name) is not a key of the table": never; }'.
  Property '"(name) is not a key of the table"' is missing in type 'readonly [ConflictRef<"name">]' but required in type '{ readonly "(name) is not a key of the table": never; }'.
```

A non-key pair, where each column belongs to some other key:

```
error TS2322: Type 'readonly [ConflictRef<"a">, ConflictRef<"e">]' is not assignable to type 'readonly [ConflictRef<"a">, ConflictRef<"e">] & { readonly "(a, e) is not a key of the table": never; }'.
  Property '"(a, e) is not a key of the table"' is missing in type ...
```

A subset of a key, `[u.a]`, prints `"(a) is not a key of the table"`. A superset, `[u.a, u.b, u.id]`, prints `"(a, b, id) is not a key of the table"`. One column of a composite primary key prints `"(x) is not a key of the table"`.

A table with no keys (`"~keys"` is `never`):

```
error TS2322: Type 'readonly [ConflictRef<"p">]' is not assignable to type 'readonly [ConflictRef<"p">] & { readonly "(p) is not a key of the table": never; }'.
```

A key pair in reversed order (`[u.b, u.a]`, `[p.y, p.x]`) passes and renders `on conflict ("b", "a") do nothing`.

A table with several keys (`id`, `email`, `(a, b)`, the partial `(c, d)`, and the index `(e, f desc)`) yields this, checked with `toEqualTypeOf`:

```ts
| readonly ["id", false] | readonly ["email", false] | readonly ["a" | "b", false]
| readonly ["c" | "d", true] | readonly ["e" | "f", false]
```

The plain index on `name` and the `lower(email)` expression index add no set.

A partial unique index's columns without `.where`:

```
error TS2339: Property 'doNothing' does not exist on type '{ where(pick: (columns: Refs<Table<{ id: Column<string, true, false, false, true, true, false, false, false>; email: Column<...>; ... 6 more ...; name: Column<...>; }, "id", KeySetsOf<...>>>) => Predicate): ConflictAction<...>; }'.
```

`.where` on a full key fails the same way: `Property 'where' does not exist on type 'ConflictAction<Table<{ ... }>, ...>'`.

## Readability (#656)

The wrong-target errors name the bad columns in the first line, as a property key, and print no `Table` type. Two gaps remain:

- They don't list the valid keys. A union of key sets has no stable order to join into a string.
- The partial-index errors print the `Table<...>` wall. A real version should give the partial clause a message key too, such as `{ "(c, d) is a partial index; call where() first": never }`, instead of relying on a missing method.

## Cost

- tsc check time went from 0.21 s to about 0.23 s with the type change alone, and to 0.25 s with the probe file. Types went from 182,634 to 187,682 (+2.8%) and instantiations from 393,459 to 421,164 (+7.0%) without the probe file. Wall time for `pnpm run typecheck` stays under 1 s and is noisier than the difference.
- `pnpm test`: 281 files and 3059 tests pass, plus the probe. `tsc` is clean.
- Lint passes after two changes: the clause builder moved out of `insertStatement`, which `max-lines-per-function` caps at 50 lines, and an `oxlint-disable` block wraps the two partial-index refusals, since a missing method types the call as an error. `foreign-keys.test.ts` and `array.test.ts` already do the same.

## Open for the real design

- Should `Refs<T>` carry its column key (`ColumnRef<V> & { "~column": K }`), so `onConflict` takes the same refs as `where` and `returning`? That costs every select error a longer type.
- `onConflict` stays callable after `doNothing()` in this stub. The real one drops it from the returned type.
- Postgres accepts a predicate on a full key and a target with an expression key. The prototype refuses the first and leaves out the second.
- The runtime never checks a target against `uniques` and `indexes`. A JavaScript caller can name any column (CODING_STANDARDS: reject unknown input by name).
