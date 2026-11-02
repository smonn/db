---
status: accepted
---

# From-first queries with column objects

Queries start with `from`, as LINQ does, so every later clause knows its row types, and each builder call maps to one SQL clause. Callbacks receive typed column objects that carry their comparisons as methods (`u.age.gt(18)`), while `and`, `or`, and `not` are plain functions exported by the package (`where((u) => or(a, b))`), so each group is written out and its nesting shows which expression is the root. TypeScript has no expression trees or operator overloading, so true LINQ lambdas are out; column methods are the closest fit.

## Considered Options

- **Imported comparison functions (Drizzle's `gt(users.age, 18)`) or string references (Kysely's `eb('age', '>', 18)`)**: users must import or remember every comparison, not just the three combinators.
- **`and`, `or`, and `not` as predicate methods (`a.or(b).and(c)`)**: short for two terms, but a chain folds left and leaves the grouping ambiguous. A reader cannot tell whether it means `(a or b) and c` or SQL's `a or (b and c)`. Separate functions make each group explicit.
- **`and`, `or`, and `not` as a second parameter of `where` (`(u, { or }) => or(a, b)`)**: nothing to import, but a parameter that exists only to carry the operators is easy to miss and easy to forget. Module exports are a little more hidden, yet they are the more familiar shape, and Drizzle does the same.
- **A list of column names in `select` (`select("id", "email")`)**: a handy shorthand, but overloading `select` turns a wrong name into a bare "No overload matches this call". It may come back later. Amended 2026-11-01: it came back as a second method, `from(users).pick("id", "email")`, beside the callback `select`, with each name selecting its column under its own key. Plain column selects are the most common query and the callback is noisy for them, and a second method is the only shape where every mistake names the bad key.
- **`sql` fragments inside `where` and `select`**: they would cover more of what the builder lacks, but they need their own design for how a fragment carries its type and composes with the builder. A whole hand-written statement is the smallest feature that unblocks hand-written reads, so the fragment design waits until a feature needs it. The row type argument that makes a statement readable is a small API change that later surfaces can reuse. Amended 2026-11-01: v0.3 ships the design as `sql.expr<V>`, described in the last consequences, with the smallest surface now: codecs on fragments and nesting can come later without a breaking change.

## Consequences

- `select` and `returning` take only an object callback, whose keys name the output columns. Amended 2026-11-01: a callback value may also be an `Expr`, as a union with refs and not an overload, and `pick` takes names only.
- `eq(null)` does not type-check. Only nullable columns have `isNull()` and `isNotNull()`.
- `and` and `or` need at least one term, and `not` takes exactly one.
- Repeated `where` calls combine with `and`.
- The escape hatch for anything the builder lacks is a whole statement written with the `sql` template. `` sql<Row>`select ...` `` is a query that `client.all` and `client.one` accept. Without a row type it is a statement only `client.run` accepts.
- `where` and `select` take only builder expressions, and `sql` refuses a statement interpolated into another. Amended 2026-11-01: they also take `sql.expr<V>` fragments, and a statement inside a fragment is still refused, so subqueries stay out of v0.3.
- Amended 2026-11-01: builder methods don't overload, because tsc reports only the last overload, so some mistake always blames the wrong signature. `values` names `id` when `nope` is the wrong key, so insert splits into `values(row)` and `valuesMany(rows)`, which carries the `~many` marker. Parameter types a user can get wrong are written inline, not through an alias, so tsc prints the keys instead of `Key<Table<...>>`.
- Amended 2026-11-01: `` sql.expr<V>`...` `` builds an `Expr<V>`, where `V` defaults to `unknown`, and whole-statement `sql<R>` is unchanged. A ref in a template renders as the builder renders it: bare on one table and alias-qualified after a join (ADR-0028). Exprs and predicates inline into an expr. Fragments run no codecs, as ADR-0022 says of `sql`.
- Amended 2026-11-01: `Predicate` becomes `Expr<boolean>`, and a `boolean | null` expr works in `where`, `on`, `and`, `or`, `not`, and `doUpdate().where`. `orderBy` takes an `Expr`, with `asc()`, `desc()`, and `nulls` only when `V` includes null. `values`, `valuesMany`, `set`, and `doUpdate` take `Expr<V>` where they take `V`, a `set` value may be `(u) => Expr<V>` (ADR-0027), and `doUpdate` takes `(existing, excluded)` (ADR-0029).
