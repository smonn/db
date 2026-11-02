---
status: accepted
---

# Ordering and set comparisons read like the SQL they render

`orderBy` takes the refs `where` gets, and `limit` and `offset` take plain numbers. `in`, `notIn`, `like`, `ilike`, and `includes` join the comparison methods, each offered only on the column types Postgres accepts it for, which a SQL type class on `Column` tells apart. Builder SQL reads like hand-written SQL, and the builder hides every call that would fail at run time, so a wrong call is a type error instead.

## Considered Options

- **A bare `IN (...)` list per value**: it renders one statement per list length, so the prepared-statement cache fills with variants, and it stops at 65533 params. `= any($1)` binds one array, keeps one prepared statement, and accepts an empty list. Postgres already stores `IN (...)` as `= ANY(ARRAY[...])`, and a generic plan of `= any($1)` estimates 10 rows for any array.
- **`between`, `notLike`, `@>`, and `&&`**: `between` parses to `>= and <=` with identical plans, so it adds a method and no capability. The others are left out of v0.3.
- **Requiring `orderBy` before `limit`**: `limit` and `offset` work alone, and the builder doesn't enforce an ordering.
- **Keyset paging helpers, and `client.one` honoring `limit(1)`**: keyset paging is out of v0.3. `client.one` ignores `limit(1)` and still throws unless exactly one row comes back.
- **A SQL type class that replaces `Int` on `Column`**: it saves no position once the flags are a named object. A merged class also compiled an identity on a domain over an integer, which Postgres refuses, so each flag keeps answering one question.
- **A class per enum label set**: it grows to 58.7k type instantiations at 200 labels, where one plain `enum` class stays cheap.

## Consequences

- `orderBy((u) => ordering | ordering[])` takes `u.x.asc()`, `u.x.desc()`, or a bare column, which means ascending, so an error never names an internal brand. Repeated calls append.
- `{ nulls: "first" | "last" }` works only on nullable columns, following the `isNull` rule, and without it Postgres's default holds. On a NOT NULL column, `asc()` and `desc()` take an inline `options?: { readonly "nulls needs a nullable column"?: never }`, so the error names `nulls`.
- `limit(n)` and `offset(n)` throw unless `n` is a non-negative safe integer.
- `in` and `notIn` render `= any($1)` and `<> all($1)`. The list binds as array text (ADR-0023) with no enum cast, so Postgres types it from the column, even on a connection opened before the enum existed. Elements are `NonNullable<V>` and pass the codec, and both methods are hidden on array columns. `notIn([])` matches every row.
- `like` and `ilike` exist only on the `text` class (text, varchar, and domains over them), because Postgres fails `like` on uuid and enum with `operator does not exist`. Array columns get `includes(value)`, rendered `$1 = any(col)`.
- The flags object of `Column` gains `sqlClass`, beside `Int`, which still gates `identity()`. The classes are `text`, `number`, `boolean`, `uuid`, `time`, `jsonb`, `bytea`, one `enum` for every enum, and `` `${class}[]` `` after `.array()`. A domain carries its base column's class, and a codec leaves it alone.
- Postgres compares an enum, a domain over one, or an array only with the identical type, which the class can't express. The class catches the common mismatch cheaply, and a build-time check when the builder joins refuses an enum or array element mismatch (ADR-0028).
- An `Expr` in `orderBy` follows ADR-0004's fragment amendment, and ordering by a joined table's column takes the positional refs of ADR-0028.
