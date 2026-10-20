---
status: accepted
---

# Definition as defineTable callbacks rolled up by defineDatabase

A Definition is one file, named in config, whose default export `defineDatabase({ public: { users, orders }, auth: { sessions } })` names schemas and tables by its keys, so the CLI reads one entry point and Node's imports find the table files. Each table is a nameless `defineTable((c) => ({ ... }))` whose callback hands over the column factories, so `c.` autocompletes every type without memorizing imports. Columns follow SQL DDL: nullable unless marked `.notNull()`, with object keys used verbatim as SQL names, because snake_case names need no quoting when someone writes SQL by hand against production.

## Considered Options

- **Exported tables collected by the CLI (Drizzle)**: users must know every factory import, the CLI has to scan modules, and a forgotten `export` looks like a dropped table.
- **One object literal holding every column**: shows everything in one place but grows into one very large file.
- **Names passed to defineTable** (`defineTable("users", ...)` or `"auth.users"`): magic strings that can drift from the rollup or collide, where object keys cannot.
- **NOT NULL by default with `.nullable()`**: friendlier to TypeScript and catches a forgotten marker early, but the project stays close to SQL and accepts that a missing `.notNull()` goes unnoticed.
- **camelCase keys mapped to snake_case**: idiomatic TypeScript, but every query, raw `sql` template, and error deals with two names. Left open as a later mapping layer, decided together with renames.
- **`table` and `database`**: shorter, but too generic for the two core calls. A verb plus a noun follows the `defineConfig` convention.

## Consequences

- A standalone `defineTable` value has no name or schema, so queries use the rolled-up tables (`from(db.public.users)`).
- Primary key columns, composite ones included, and identity columns are NOT NULL without `.notNull()`, as Postgres makes them.
- Until renames land after v0.1, renaming a key generates a drop and create, flagged as data loss.
- A shared column helper is a function of the factories, such as `(c) => ({ created_at: c.timestamptz().notNull() })`.
