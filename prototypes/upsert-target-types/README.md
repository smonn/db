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

## Second probe: the maintainer's decisions (Q5, Q6, Q7, Q12)

All four hold. Two needed a change to the obvious shape: the set check is a generic with a self-referential constraint, since excess-property checks skip a callback's returned object, and `identity()` carries its mode in the column type. tsc 7, `--pretty false`, PostgreSQL 18 in the test container.

### What changed

- `on-conflict.ts` holds the clause types and runtime. `insert.ts` keeps `onConflict` as one generic method.
- `KeySet` is `readonly [columns, false | position]`: `false` for a full key, the `indexes` position for a partial unique index. `indexes` is typed `readonly [] | readonly IndexEntry[]`, so TypeScript infers a tuple and two partial indexes on one column set stay apart in the union.
- `Column`'s `Gen` parameter widens to `boolean | "always"`. `identity<G>()` is generic, `~types` gains `generated`, and the `default()`/`identity()` gate flips to `Gen extends false`. No new type parameter, no overload.
- `ColumnRef`'s comparisons take `Operand<V>`: a value, or any column of the same type, nullable or not. A WeakMap from ref to its SQL tells a ref from a row value at run time, so a jsonb value can't pass for a column.
- `refsOf(table, qualifier)` prefixes columns: `excluded."name"` and `"public"."items"."version"`.
- `sql/` gains `verbatim(text)`, which inlines the Definition's already-rendered index predicate.
- The runtime now checks every target against the table's keys and indexes and throws, naming the columns and table, when none matches or two partial indexes do. This closes the first probe's last open point.

### 1. Target predicate (Q12): holds

The builder appends the predicate of the one partial unique index behind a target, through the index's remembered expression, so `casing` renames its columns. A full key on the same set wins and adds nothing.

| Definition                                  | Rendered                                                    |
| ------------------------------------------- | ----------------------------------------------------------- |
| `(tag)` partial `where deletedAt is null`   | `on conflict ("tag") where "deleted_at" is null do nothing` |
| `(c, d)` partial, target `[u.d, u.c]`       | `on conflict ("d", "c") where "c" is not null do nothing`   |
| `tag` `.unique()` plus a partial on `(tag)` | `on conflict ("tag") do nothing`                            |
| `(b, a)` for `unique (a, b)`                | `on conflict ("b", "a") do nothing`                         |

Against Postgres, the partial case inserts once (`count: 1`) and skips the second insert (`count: 0`), so Postgres infers the index.

Two partial unique indexes on `(tag)`, no full key:

```
error TS2322: Type 'readonly [ConflictRef<"tag">]' is not assignable to type 'readonly [ConflictRef<"tag">] & Refusal<"(tag) has several partial unique indexes and no full key">'.
  Property '"(tag) has several partial unique indexes and no full key"' is missing in type 'readonly [ConflictRef<"tag">]' but required in type 'Refusal<"(tag) has several partial unique indexes and no full key">'.
```

The run-time twin throws `("tag") has several partial unique indexes on "public"."twice"`.

Gaps: a column-level `.index()` takes no `unique` or `where` today, so only the second callback's `indexes` feeds this. The tuple inference rests on the `readonly []` member of the contextual type. A Definition that builds `indexes` as a variable typed as an array, not a tuple, should get one merged set again, so the type would stop refusing the duplicate while the runtime still does (untested).

### 2. `doUpdate` (Q5): holds with a change

`doUpdate((excluded) => ({ name: excluded.name, seenAt: new Date(), note: null }))` renders `do update set "name" = excluded."name", "seen_at" = $5, "note" = $6`. An `undefined` value is skipped, and a set left empty throws `doUpdate needs at least one column to set`.

The first shape, an optional mapped type as the callback's return type, let `{ name: "x", nope: 1 }` and `{ tag: "y", id: 3 }` compile: TypeScript runs no excess-property check on a callback's returned object. The probe infers the object as `S` and constrains `S` against a mapped type over its own keys, which turns each bad key into a message. It still prints the column keys inline, not `Table<...>`:

| Misuse                                         | tsc                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wrong key `{ nope: 1 }`                        | `Type 'number' is not assignable to type '"nope is not a column"'.`                                                                                                                                     |
| wrong literal `{ name: 1 }`                    | `Type 'number' is not assignable to type 'string \| ColumnOf<string> \| undefined'.`                                                                                                                    |
| `name: excluded.version`                       | `Type 'ColumnRef<number>' is not assignable to type 'string \| ColumnOf<string> \| undefined'.` then `Types of property '"~value"' are incompatible. Type 'number' is not assignable to type 'string'.` |
| identity always `{ id: 3 }`                    | `Type 'number' is not assignable to type '"id is an identity always column, which Postgres won't update"'.`                                                                                             |
| `{ name: null }` on NOT NULL                   | `Type 'null' is not assignable to type 'string \| ColumnOf<string> \| undefined'.`                                                                                                                      |
| `name: excluded.note` (nullable into NOT NULL) | as the excluded-ref row, ending `Type 'null' is not assignable to type 'string'.`                                                                                                                       |

Each error points at the offending property. A NOT NULL excluded ref into a nullable column passes. A string literal equal to a refusal message would pass the type, and the runtime refusals still apply.

Cost of identity: `Gen` widens rather than a tenth parameter, so the change is one generic method and a flipped gate. `NewRow` still requires an identity column's value on insert, a separate gap, so the Postgres run uses a table without one.

### 3. `DO UPDATE ... WHERE` (Q6): holds

`.where((existing, excluded) => excluded.version.gt(existing.version)).where((existing) => existing.note.isNull())` renders:

```
... do update set "name" = excluded."name", "version" = excluded."version" where (excluded."version" > "public"."items"."version" and "public"."items"."note" is null)
```

Postgres rejects the unqualified form, `where excluded.v > v`, with `column reference "v" is ambiguous`, so the existing row's columns carry the schema-qualified table name. Against Postgres, versions 1, 2, then 1 return `[{one, 1}]`, `[{two, 2}]`, then `[]`. The comparisons gained a column operand for this, which every `where` now shares.

### 4. `~maybe` (Q7): holds

`doNothing()` and `doUpdate(...).where(...)` add `Maybe`, carried through `returning`. A bare `doUpdate` keeps the insert's marker: `client.one` takes it after `values(row)` and refuses it after `values([...])` through `~many`. `client.all` takes them all. The marker's value is the message:

```
error TS2345: Argument of type 'Statement & { readonly "~returns": "rows"; readonly "~row": Selected<{ sku: ColumnRef<string>; }>; } & Maybe' is not assignable to parameter of type 'Statement & { ... } & { readonly "~many"?: never; readonly "~maybe"?: never; }'.
  ...
    Types of property '"~maybe"' are incompatible.
      Type '"on conflict may skip the row; run it with client.all"' is not assignable to type 'never'.
```

The last line reads as a missing-row problem. The first line prints the query type, which grows with the selection, as the existing `~many` refusal does.

### 5. Chain order: the shape prevents it

`doNothing()` returns `ConflictStatement` (`returning`, `toSql`), and `doUpdate()` returns `UpdateStatement` (adds `where`). Neither has `onConflict` or `doUpdate`, so a second clause is absent:

```
error TS2339: Property 'onConflict' does not exist on type 'ConflictStatement<Table<{ sku: Column<string, true, ...>; ... }, never, readonly [...]>, Maybe>'.
```

That error prints the `Table<...>` wall. `where` after `doNothing()` fails the same way. A real version could give each a message key, as #656 asks.

### Cost (against the first probe's head, 9844ee9)

| Measure                          | 9844ee9                | This probe     | Delta        |
| -------------------------------- | ---------------------- | -------------- | ------------ |
| Types, with probe tests          | 190,636                | 193,141        | +1.3%        |
| Instantiations, with probe tests | 431,157                | 439,844        | +2.0%        |
| Types, without probe tests       | 187,682 (first README) | 188,351        | +0.4%        |
| Instantiations, without          | 421,164 (first README) | 423,668        | +0.6%        |
| Check time, 3 runs               | 0.25 to 0.31 s         | 0.28 to 0.33 s | within noise |

`pnpm test`: 282 files, 3068 tests pass. `pnpm run check:static` passes.

### Open for the real design

- The set and target refusals print as `Refusal<...>` and template-literal types. Spelling out `Refusal` would drop one alias from the first line.
- `operandOf` widens every comparison to take a column. That also opens joins and column-to-column filters, so it needs its own decision rather than riding in with upsert.
- `NewRow` should let an identity or default column be left out (#657's territory).
- `Statement` errors from the chain-order mistakes print the table type; message keys would fix it.
