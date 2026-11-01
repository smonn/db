---
status: proposed
---

# Upserts name a declared key

`onConflict((u) => [u.email])` takes a column list that must match a key the Definition declares, and returns only `doNothing()` and `doUpdate(...)`. Neither half alone is a Statement, and no target-free form exists. Like `allRows()`, the dangerous form must be spelled out, here as whole-statement `sql`, and a skipped row is a normal outcome, so `doNothing()` and a conditional `doUpdate` carry a `~maybe` marker that `client.one` refuses.

## Considered Options

- **Targets by constraint name or by expression**: they need whole-statement `sql`.
- **No compile-time target check**: first judged too costly. A probe showed it costs 7% more tsc instantiations and no measurable check time, so a wrong target fails to compile.
- **Overloaded targets, one per kind**: ADR-0004's amendment rules overloads out, so each target kind would be its own method or option, and only the column list ships.

## Consequences

- `Table` gains a third type parameter that holds its keys: the primary key, `unique()` columns, `unique` entries, and unique indexes on plain columns. A wrong target fails with `(name) is not a key of the table`, in any column order, and the builder checks again for JS callers.
- A target that only a partial unique index backs gets that index's `where` appended. Two partial indexes on the same columns are a type error.
- `onConflict`'s callback gets its own name-carrying refs.
- `doUpdate((existing, excluded) => ({...}))` takes literals, same-typed `excluded` refs, or `Expr<V>` (ADR-0004's amendment), so `n = n + excluded.n` works through `sql.expr`. It follows ADR-0027's `set` rules: no `identity("always")` columns, undefined skipped, and an empty set refused. `identity()` carries its mode in `Column`'s `Gen` slot.
- `.doUpdate(...).where((existing, excluded) => ...)` combines with `and` and schema-qualifies existing-row columns.
- `returning` yields only the rows written, so a skipped row is absent. `client.one` refuses with `on conflict may skip the row; run it with client.all`, and `client.all` may return fewer rows than were inserted.
- `onConflict`'s doc comment names two Postgres behaviors. A nullable key never conflicts on NULL, and a key repeated in one `valuesMany` fails under `doUpdate` and keeps the first row under `doNothing`.
