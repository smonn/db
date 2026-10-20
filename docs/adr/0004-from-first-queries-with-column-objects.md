---
status: proposed
---

# From-first queries with column objects

Queries start with `from`, as LINQ does, so every later clause knows its row types, and each builder call maps to one SQL clause. Callbacks receive typed column objects that carry their comparisons as methods (`u.age.gt(18)`), while `and`, `or`, and `not` come from `where`'s second argument (`(u, { or }) => or(a, b)`), so nothing needs importing and the nesting shows which expression is the root. TypeScript has no expression trees or operator overloading, so true LINQ lambdas are out; column methods are the closest fit.

## Considered Options

- **Imported operator functions (Drizzle's `gt(users.age, 18)`) or string references (Kysely's `eb('age', '>', 18)`)**: users must import or remember the operators.
- **`and`, `or`, and `not` as predicate methods (`a.or(b).and(c)`)**: short for two terms, but a chain reads left to right and hides which expression is the root.
- **A list of column names in `select` (`select("id", "email")`)**: a handy shorthand, but overloading `select` turns a wrong name into a bare "No overload matches this call". It may come back later.

## Consequences

- `select` and `returning` take only an object callback, whose keys name the output columns.
- `eq(null)` does not type-check. Only nullable columns have `isNull()` and `isNotNull()`.
- A typed `sql` template covers anything the builder lacks.
