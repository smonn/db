---
status: accepted
---

# From-first queries with column objects

Queries start with `from`, as LINQ does, so every later clause knows its row types, and each builder call maps to one SQL clause. Callbacks receive typed column objects that carry their comparisons as methods (`u.age.gt(18)`), while `and`, `or`, and `not` are plain functions exported by the package (`where((u) => or(a, b))`), so each group is written out and its nesting shows which expression is the root. TypeScript has no expression trees or operator overloading, so true LINQ lambdas are out; column methods are the closest fit.

## Considered Options

- **Imported comparison functions (Drizzle's `gt(users.age, 18)`) or string references (Kysely's `eb('age', '>', 18)`)**: users must import or remember every comparison, not just the three combinators.
- **`and`, `or`, and `not` as predicate methods (`a.or(b).and(c)`)**: short for two terms, but a chain folds left and leaves the grouping ambiguous. A reader cannot tell whether it means `(a or b) and c` or SQL's `a or (b and c)`. Separate functions make each group explicit.
- **`and`, `or`, and `not` as a second parameter of `where` (`(u, { or }) => or(a, b)`)**: nothing to import, but a parameter that exists only to carry the operators is easy to miss and easy to forget. Module exports are a little more hidden, yet they are the more familiar shape, and Drizzle does the same.
- **A list of column names in `select` (`select("id", "email")`)**: a handy shorthand, but overloading `select` turns a wrong name into a bare "No overload matches this call". It may come back later.

## Consequences

- `select` and `returning` take only an object callback, whose keys name the output columns.
- `eq(null)` does not type-check. Only nullable columns have `isNull()` and `isNotNull()`.
- `and` and `or` need at least one term, and `not` takes exactly one.
- Repeated `where` calls combine with `and`.
- A typed `sql` template covers anything the builder lacks.
