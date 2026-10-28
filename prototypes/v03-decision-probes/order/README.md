# Prototype: ordering, paging, and set and pattern comparisons

Throwaway probe of #655 (map #652, probes #672). Question: do the decided `orderBy`, `nulls`, `limit`/`offset`, `in`/`notIn`, `like`/`ilike`, and `includes` shapes type cleanly, name each misuse, and run on Postgres?

## Verdict

| Sub-decision                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderBy((u) => ordering \| ordering[])`, bare column is asc, calls append                                 | **Keep.** Every misuse fails with a one-line error naming the bad input.                                                                                                                                                                                                                                                                                    |
| `{ nulls }` only on nullable columns                                                                       | **Amend:** keep the option, but give a NOT NULL column's `asc`/`desc` an inline `{ "nulls needs a nullable column"?: never }` parameter instead of none. With no parameter, tsc prints `Expected 0 arguments, but got 1`, which never mentions `nulls`.                                                                                                     |
| `limit`/`offset` validated at run time                                                                     | **Keep.** Postgres refuses the same values, but only on the server and with a bigint parse error for a fraction.                                                                                                                                                                                                                                            |
| `in`/`notIn` as `= any($1)` / `<> all($1)`, cast to `$1::text[]::schema.type[]` on enum and domain columns | **Amend:** drop the cast and bind the list as array text, the way array-column values are already sent (ADR-0023). Also hide `in`/`notIn` on array columns. The cast needs each enum's and domain's SQL name at query time, which `Table` doesn't carry. Array text works on a connection opened before the enum existed, with no cast and no new plumbing. |
| `like`/`ilike` through a `Text` parameter beside `Int`                                                     | **Amend:** replace `Int` with one `Kind` parameter, `"integer" \| "text" \| "array" \| "other"`. That keeps nine parameters instead of ten, also covers `includes` and `identity`, and costs a third of the instantiations.                                                                                                                                 |
| `includes` on array columns                                                                                | **Amend:** read array-ness from `Kind`, not from the value type. `Column` has no array flag, so the decided shape has to infer it from `V`. That offers `includes` on `jsonb<string[]>()`, which fails on Postgres.                                                                                                                                         |

## What changed

Two commits. The first builds the decided shape. The second is the alternative that wins.

- `query/probe-order.ts` (new) holds the types and the runtime: `Ordering`, `OrderingMethods<V>`, `SetMethods<V>`, `TextMethods`, `ArrayMethods<V>`, `KindMethods<V, K>`, `KindOf<Col>`, the renderers, and `countOf`. It restates `Predicate` rather than importing it, since `from.ts` imports it (no-cycles).
- `query/from.ts`: `ColumnRef<V, Kind>` adds `OrderingMethods<V> & KindMethods<V, Kind>`. `Refs<T>` reads each column's kind from `"~types"`. `SelectQuery` gains `orderBy`, `limit`, and `offset`, and `toSql` appends `order by`, `limit $n`, and `offset $n`.
- `definition/column.ts`: the decided commit adds `Text extends boolean` as the fourth parameter and `"~types".text`. The alternative replaces `Int` with `Kind extends ColumnKind = "other"` and `"~types".kind`. `.array()` sets `"array"`, and `identity()` checks `Kind extends "integer"`.
- `definition/column-kind.ts` (new) holds `ColumnKind`. It is a separate file because `domain.ts` needs it and `column.ts` already imports `domain.ts`.
- `definition/factories.ts`: `text`/`varchar` are `"text"`, `smallint`/`integer`/`bigint` are `"integer"`. `domain(d)` keeps `"text"` and maps every other kind to `"other"`, so a domain column still has no `identity()`, as today.
- `definition/domain.ts`, `define-domain.ts`: `Domain<V, N, K>` carries its base's kind.
- Tests: `probe-order.test.ts` covers types and rendered SQL. `probe-order-pg.test.ts` runs on Postgres over one connection that opens before the enum and domains exist. The tests are split only because of the fta score cap.

## Postgres facts

Checked on PostgreSQL 18.6 through `postgresJsDriver`, on a connection opened before the types:

| Statement                                           | Result                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `mood = any($1)`, `$1` a JS array                   | ERROR: `malformed array literal: "sad"` (#654)                                                                                          |
| `mood = any($1)`, `$1` array text `'{"sad","ok"}'`  | OK. The untyped param takes `mood[]` from the column.                                                                                   |
| `mood = any($1::text[]::public.mood[])`, JS array   | OK, and also for domains over integer, bytea, jsonb, and timestamptz                                                                    |
| `= any('{}')`                                       | No rows                                                                                                                                 |
| `<> all('{}')`                                      | **Every row, NULL ones too.** `NULL <> all('{sad}')` is NULL, so `notIn([])` matches a row with a NULL value that `notIn(["x"])` drops. |
| `tags = any('{{a,b}}')` (`in` on a `text[]` column) | ERROR: `could not find array type for data type text[]`                                                                                 |
| `$1 = any(meta)`, `meta jsonb` holding an array     | ERROR: `op ANY/ALL (array) requires array on right side`                                                                                |
| `$1 = any(tags)` on `text[]`, and on `mood[]`       | OK                                                                                                                                      |
| `like` on uuid, enum, `text[]`, jsonb               | ERROR: `operator does not exist: uuid ~~ unknown` (and the same for the others)                                                         |
| `like` on a domain over text                        | OK                                                                                                                                      |
| `limit $1` with -1 / `offset $1` with -1            | ERROR: `LIMIT must not be negative` / `OFFSET must not be negative`                                                                     |
| `limit $1` with 1.5, NaN, or Infinity               | ERROR: `invalid input syntax for type bigint: "1.5"`                                                                                    |
| `limit $1` with 2^53 + 2, or null                   | OK. A null limit means no limit.                                                                                                        |
| `order by m desc`                                   | NULLs first by default. `nulls last` moves them.                                                                                        |
| `order by` jsonb, `text[]`                          | OK, so every factory type can be ordered                                                                                                |

Unrelated finding: a scalar object bound to a **domain over jsonb** fails on every connection with `invalid input syntax for type json`, through `insert` as well. postgres.js has no serializer for the domain's OID. Arrays of that domain work, because they go as array text.

## Error texts (tsc, `--pretty false`)

Both shapes:

```
orderBy((u) => u.id.eq(1))          TS2322: Type 'Predicate' is not assignable to type 'readonly OrderTerm[] | OrderTerm'.
orderBy(() => "id")                 TS2322: Type 'string' is not assignable to type 'readonly OrderTerm[] | OrderTerm'.
orderBy((u) => [u.id, "desc"])      TS2322: Type 'string' is not assignable to type 'OrderTerm'.
u.nick.asc({ nulls: "middle" })     TS2322: Type '"middle"' is not assignable to type '"first" | "last"'.
u.nick.in([null])                   TS2322: Type 'null' is not assignable to type 'string'.
u.qty.in(["1"])                     TS2322: Type 'string' is not assignable to type 'number'.
u.mood.in(["angry"])                TS2322: Type '"angry"' is not assignable to type 'NonNullable<"happy" | "ok" | "sad" | null>'.
```

`nulls` on a NOT NULL column:

```
decided    TS2554: Expected 0 arguments, but got 1.
amended    TS2353: Object literal may only specify known properties, and 'nulls' does not exist in type '{ readonly "nulls needs a nullable column"?: never; }'.
amended, a variable `{ nulls } as const`:
           TS2559: Type '{ readonly nulls: "first"; }' has no properties in common with type '{ readonly "nulls needs a nullable column"?: never; }'.
```

With a named alias (`NoNulls`) the message prints `type 'NoNulls'` and loses the reason, so the type has to stay inline (#656's rule). The method alternative, `ascNullsFirst()`, prints `Property 'ascNullsFirst' does not exist on type 'ColumnRef<string, "text">'`. That names the method but not why, and it adds four methods to every nullable column.

Hidden methods (`like` on uuid, `includes` on text, and so on) print `Property 'like' does not exist on type 'ColumnRef<string | null, "other">'`. The decided shape prints `ColumnRef<string | null, false>`. Neither prints a wall. The decided shape compiles `u.meta.includes("a")` on `jsonb<string[]>()` and `u.tags.in([["a"]])`, and both fail on Postgres. `Kind` refuses them with `Property 'includes' does not exist on type 'ColumnRef<string[] | null, "other">'` and `Property 'in' does not exist on type 'ColumnRef<(string | null)[] | null, "array">'`.

How each shape prints a `Column` in an unrelated error (`c.text().notNull().identity()`):

```
main      Column<string, true, false, false, false, false, false, false, false>
decided   Column<string, true, false, true, false, false, false, false, false, false>
Kind      Column<string, true, "text", false, false, false, false, false, false>
```

## Cost

`tsc --noEmit --extendedDiagnostics`, three runs each. Types and instantiations are the same on every run. Check time is the median, with runs against `main` interleaved.

| Tree                         | Types           | Instantiations  | Check time |
| ---------------------------- | --------------- | --------------- | ---------- |
| main                         | 182,634         | 393,459         | 0.22 s     |
| decided, without probe tests | 185,210 (+1.4%) | 404,096 (+2.7%) | 0.21 s     |
| decided, with probe tests    | 186,539         | 407,206 (+3.5%) | 0.22 s     |
| Kind, without probe tests    | 183,995 (+0.7%) | 397,041 (+0.9%) | 0.21 s     |
| Kind, with probe tests       | 185,415         | 399,315 (+1.5%) | 0.22 s     |

Check time is noise at this size. `pnpm test`: 282 files and 3077 tests pass. `tsc` is clean, and lint, format, fta, and import cycles pass.

## Open for the real design

- `like` on a text column with a codec (`c.text().codec<URL>()`) keeps `"text"`. The probe sends the pattern raw, skipping the codec. Should `.codec()` reset the kind to `"other"`?
- `in` runs each element through the column's codec through `encodeValue`. No test here covers a codec column.
- `notIn([])` matching NULL rows is Postgres's answer. I recall that Drizzle's `notInArray(col, [])` renders `true` as well, but I haven't checked. It needs a line in the docs, not a different rendering.
- The `in` element error prints `NonNullable<...>` unresolved. A mapped helper would print the labels.
- `Kind` is a `Column` parameter, so the parent's merge with other probes that touch `column.ts` positional arguments (`Int`) conflicts by design.
- Not weighed beyond reasoning: an object `orderBy({ name: "desc" })` (string keys instead of the refs `where` gets, no answer for joined tables in #658, and JavaScript lists integer-like keys first), and `eq` taking an array (`eq` already compares a whole array on an array column).
