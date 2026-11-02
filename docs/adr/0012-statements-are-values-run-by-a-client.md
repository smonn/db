---
status: accepted
---

# Statements are values that a client runs

`from` and `insert` are plain imports that build a statement value, with `toSql()` and no database attached, and `client.all`, `client.one`, and `client.run` send it through the Driver. A statement can then be built once at module scope, tested without a database, and run inside a transaction by that transaction's client. Awaiting the builder directly can be added later as sugar without a breaking change, whereas removing it after release would break callers.

## Considered Options

- **Builders awaited on a bound client (Drizzle, Kysely)**: one call shorter, but every client and transaction needs its own builders, and an insert nobody awaits never runs.
- **Both from v0.1**: two ways to run one statement from the first release.

## Consequences

- `client.one` throws unless exactly one row comes back.
- An insert without `returning` yields no rows, so only `client.run` accepts it, and it returns `{ count }`.
- The postgres.js Driver has to send `toSql()` text through `sql.unsafe`, which skips prepared statements unless it passes `{ prepare: true }`.
- Named placeholders bound at run time (`client.all(q, { minAge: 18 })`) stay open for after v0.1. Amended 2026-11-01: this consequence is replaced. A run-time value comes from a function that builds the statement, as in `const byAge = (minAge: number) => from(users).where((u) => u.age.gte(minAge))` and `client.all(byAge(18))`. TypeScript types the parameters, values go through column codecs as before, and the client takes no second argument. postgres.js caches a prepared statement per connection by types and text, so calls with different values reuse one prepared statement. Placeholders would add a typed hole, name tracking, a second client argument, and an `sql` scanner, all to save one arrow function.
