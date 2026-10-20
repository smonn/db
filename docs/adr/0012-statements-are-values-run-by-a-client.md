---
status: proposed
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
- Named placeholders bound at run time (`client.all(q, { minAge: 18 })`) stay open for after v0.1.
