---
status: proposed
---

# Update and delete need a where or `allRows()`

`update(users).set({...})` and `deleteFrom(users)` return a builder with only `where(...)` and `allRows()`. It is not a Statement, so `client.run(deleteFrom(users))` fails to compile, and a runtime check refuses it for JS callers. A forgotten `where` empties or rewrites a table in production, and a type error at the call beats that, the rule the builder already follows for calls that fail at run time.

## Considered Options

- **Running a missing `where` as written, or behind an opt-in flag**: the first lets a forgotten `where` through. Spelling `allRows()` out makes every whole-table write deliberate.
- **`UPDATE ... FROM` and `DELETE ... USING`**: Postgres picks an arbitrary row when several join rows match, and a missing join condition is a cross join. Whole-statement `sql` covers them until the builder has joins.
- **Postgres 18 `old` and `new` in `returning`**: not in v0.3.
- **Column arithmetic in `set`** (`n = n + 1`, `now()`): handled by fragments (ADR-0004's amendment), not by new operators on columns.
- **One `set((u) => ...)` callback for the whole row**: a tsc probe showed it compiles a typo'd key, where per-key callbacks flag every misuse on the bad key.

## Consequences

- Repeated `where` calls combine with `and`, as on `from`. `allRows()` carries the `~many` marker.
- `returning(u => ({...}))` reuses insert's shape, with new values for update and deleted values for delete. Without it, only `client.run` accepts the statement. With it, `client.all` and `client.one` both do, with no `~many` marker, so `client.one` on a primary key `where` is the not-found check.
- `set`'s parameter type is written inline and lists every column except `identity("always")`, each optional, with `null` only on nullable columns. That needs `identity()` to carry its mode in the column type, which costs 0.5% more instantiations and no measurable check time.
- An `identity("always")` column sits under a message key in `set`'s type, so `set({ id: 5 })` prints `"id is generated always, so update can't set it"` instead of a false `'id' does not exist`. The message key compiles and throws at run time as an unknown key.
- An undefined value is skipped at run time, and a `set` left empty throws `update needs at least one column to set`. Values pass the column's codec when the statement renders.
- A `set` value may also be `(u) => Expr<V>`, one callback per key, so `n = n + 1` works through `sql.expr` (ADR-0004's amendment).
- `Statement`, `Query`, `Many`, and `brand` move out of the select builder into `statement.ts`, and the refs, predicates, `columnIdentifier`, `renderOutput`, and a shared `returning` builder into `refs.ts`, so each new statement imports shared plumbing instead of the select builder.
- An update or delete that can't run yet still prints a `Table<...>` error wall and never says to call `where`. The fix spans the whole builder, so it is tracked apart from this decision.
