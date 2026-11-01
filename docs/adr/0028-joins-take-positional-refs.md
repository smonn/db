---
status: proposed
---

# Joins take positional refs

`from(users).innerJoin(posts, (u, p) => p.authorId.eq(u.id))` adds one callback parameter per joined table, in join order, to `on`, `where`, `select`, and `orderBy`, so a self-join needs no alias argument. `on` is required and a joined builder becomes a Query only after `select`, so a forgotten condition or a colliding `id` is a type error, the rule the builder already follows. Table and schema names stay typed as `string`, since positional refs need no literal names, which answers why they never got literal types.

## Considered Options

- **Right, full, and cross joins**: two join kinds keep the types small. A cross join is what a forgotten condition would produce, so whole-statement `sql` covers all three.
- **An optional `on`**: a missing condition would compile into a cross join.
- **Named aliases for each table**: a self-join then needs an alias argument, which positional refs avoid.
- **Literal table and schema names**: they would cost only 148 more instantiations, so cost didn't decide it. Nothing in the positional design reads them.
- **Matching column operands by TypeScript type**: it compiled `uuid = text`, which Postgres fails, and refused `integer = bigint`, which runs.
- **`pick` after a join**: two tables can share a name such as `id`, so `pick` is hidden after a join and `select` names each column.

## Consequences

- `innerJoin(t, on)` and `leftJoin(t, on)` come before `select`, whose type drops the join methods. `where`, `orderBy`, `limit`, and `offset` may come before or after it, and a runtime check refuses a joined builder that never reached `select`.
- `eq`, `ne`, `gt`, `gte`, `lt`, and `lte` take a value or a ColumnRef of the same non-null type, in `on` and `where`. The parameter is a union, not an overload (ADR-0004's amendment), and a column operand skips codecs.
- Operands match on the SQL type class beside `Int` (ADR-0026), not the TypeScript type. That costs 7.4% more instantiations inline and leaves check time unchanged. Enums with the same labels still compare, and a build-time check refuses an enum or array element mismatch the class can't see. Nullable and left-joined columns work as operands, and `on` sees its own table as declared.
- After `leftJoin`, that table's refs are `ColumnRef<V | null>`, so they gain `isNull()` and select as `V | null`. A left join's NULL skips the decoder.
- A joined query aliases each table by its SQL name, with `_2` and `_3` on a repeat that skip names in use, and it cuts the table name so name plus suffix fits in 63 bytes. Every column is qualified, as in `"posts"."author_id" as "authorId"`. Single-table SQL is unchanged.
- Each output carries its table, so codecs, `casing`, and `.name()` resolve per table.
- A fragment ref renders with the same alias (ADR-0004's amendment).
- Comparisons keep these two operand forms: ADR-0012's amendment adds no placeholder as a third.
