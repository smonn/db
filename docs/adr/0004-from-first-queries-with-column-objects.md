---
status: accepted
---

# From-first queries with column objects

Queries start with `from`, as LINQ does, so every later clause knows its row types, and each builder call maps to one SQL clause. Callbacks receive typed column objects that carry their operators as methods (`u.age.gt(18)`), rather than Drizzle's imported operator functions (`gt(users.age, 18)`) or Kysely's string references (`eb('age', '>', 18)`). TypeScript has no expression trees or operator overloading, so true LINQ lambdas are out; column methods are the closest fit that needs no imports. A typed `sql` template covers anything the builder lacks.
