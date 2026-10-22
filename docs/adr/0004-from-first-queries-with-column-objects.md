---
status: proposed
---

# From-first queries with column objects

Queries start with `from`, as LINQ does, so every later clause knows its row types, and each builder call maps to one SQL clause. Callbacks receive typed column objects that carry their comparisons as methods (`u.age.gt(18)`), while `and`, `or`, and `not` are plain functions exported by the package (`where((u) => or(a, b))`), so each group is written out and its nesting shows which expression is the root. TypeScript has no expression trees or operator overloading, so true LINQ lambdas are out; column methods are the closest fit.

## Considered Options

- **Imported comparison functions (Drizzle's `gt(users.age, 18)`) or string references (Kysely's `eb('age', '>', 18)`)**: users must import or remember every comparison, not just the three combinators.
- **`and`, `or`, and `not` as predicate methods (`a.or(b).and(c)`)**: short for two terms, but a chain folds left and leaves the grouping ambiguous. A reader cannot tell whether it means `(a or b) and c` or SQL's `a or (b and c)`. Separate functions make each group explicit.
- **`and`, `or`, and `not` as a second parameter of `where` (`(u, { or }) => or(a, b)`)**: nothing to import, but a parameter that exists only to carry the operators is easy to miss and easy to forget. Module exports are a little more hidden, yet they are the more familiar shape, and Drizzle does the same.
- **A list of column names in `select` (`select("id", "email")`)**: a handy shorthand, but overloading `select` turns a wrong name into a bare "No overload matches this call". It may come back later.
- **`sql` fragments inside `where` and `select`**: they would cover more of what the builder lacks, but they need their own design for how a fragment carries its type and composes with the builder. A whole hand-written statement is the smallest feature that unblocks hand-written reads, so the fragment design waits until a feature needs it. The row type argument that makes a statement readable is a small API change that later surfaces can reuse.

## Consequences

- `select` and `returning` take only an object callback, whose keys name the output columns.
- `eq(null)` does not type-check. Only nullable columns have `isNull()` and `isNotNull()`.
- `and` and `or` need at least one term, and `not` takes exactly one.
- Repeated `where` calls combine with `and`.
- The escape hatch for anything the builder lacks is a whole statement written with the `sql` template. `` sql<Row>`select ...` `` is a query that `client.all` and `client.one` accept. Without a row type it is a statement only `client.run` accepts.
- `where` and `select` take only builder expressions, and `sql` refuses a statement interpolated into another.
