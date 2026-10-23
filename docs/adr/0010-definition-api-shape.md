---
status: proposed
---

# Definition as defineTable callbacks rolled up by defineDatabase

A Definition is one file, named in config, whose default export `defineDatabase({ public: { users, orders }, auth: { sessions } })` names schemas and tables by its keys, so the CLI reads one entry point and Node's imports find the table files. Each table is a nameless `defineTable((c) => ({ ... }), (t) => ({ primaryKey? }))`: the first callback hands over the column factories, so `c.` autocompletes every type without memorizing imports, and the optional second hands over typed references to the table's columns for table-level entries. Columns follow SQL DDL: nullable unless marked `.notNull()`, with object keys used verbatim as SQL names, because snake_case names need no quoting when someone writes SQL by hand against production.

## Considered Options

- **Exported tables collected by the CLI (Drizzle)**: users must know every factory import, the CLI has to scan modules, and a forgotten `export` looks like a dropped table.
- **One object literal holding every column**: shows everything in one place but grows into one very large file.
- **Names passed to defineTable** (`defineTable("users", ...)` or `"auth.users"`): magic strings that can drift from the rollup or collide, where object keys cannot.
- **NOT NULL by default with `.nullable()`**: friendlier to TypeScript and catches a forgotten marker early, but the project stays close to SQL and accepts that a missing `.notNull()` goes unnoticed.
- **camelCase keys mapped to snake_case**: idiomatic TypeScript, but every query, raw `sql` template, and error deals with two names. Left open as a later mapping layer, decided together with renames.
- **A plain options object with string column names** (`{ primaryKey: ["a", "b"] }`): a misspelled name is caught only by a check, editor renames skip the strings, and a later index or check could not point at a column inside a SQL expression.
- **A Drizzle-style array of builders** (`(t) => [primaryKey({ columns: [t.a, t.b] })]`): it has the same typed references, but one primary key per table becomes a runtime check where an object keyed by kind lets the type enforce it.
- **`table` and `database`**: shorter, but too generic for the two core calls. A verb plus a noun follows the `defineConfig` convention.

## Consequences

- A standalone `defineTable` value has no name or schema, so queries use the rolled-up tables (`from(db.public.users)`).
- Primary key columns, composite ones included, and identity columns are NOT NULL without `.notNull()`, as Postgres makes them.
- A single-column primary key goes on the column with `.primaryKey()`, and a composite one goes in the second callback's `primaryKey`, as references in the written order. Declaring both, or `.primaryKey()` on several columns, is a compile error where the types can express it and fails at load otherwise.
- A composite key's column order sets its index order and can differ from declaration order. Marking columns one by one leaves that order implicit and lets two marks silently form a key.
- A key in the second callback lists at least two columns; a single column goes on the column.
- The references make a column name checked by the type, so an editor rename follows it. Later table-level entries (multi-column indexes, checks, triggers) can name columns through the same references, including inside SQL expressions, under their own keys of the returned object.
- `.identity()` without an argument means `"by default"`. `"always"` refuses explicit values unless the insert says `OVERRIDING SYSTEM VALUE`, which surprises anyone seeding or copying data, so `"by default"` is the less hostile default.
- Until renames land after v0.1, renaming a key generates a drop and create, flagged as data loss.
- A shared column helper is a function of the factories, such as `(c) => ({ created_at: c.timestamptz().notNull() })`, and the exported `ColumnFactories` type lets the helper declare its parameter.
- `Row<typeof t>` types a query result and `NewRow<typeof t>` an insert's input, for a standalone or a rolled-up table.
- Column values map to TypeScript as `bigint` for `bigint`, `string` for `numeric` and `date`, `Date` for `timestamp` and `timestamptz`, `T` for `jsonb<T>()`, and `Uint8Array` for `bytea`. Overriding the mapping with a codec waits until after v0.1.

## Open questions

- Why `bigint` maps to `bigint`, and `numeric` and `date` to `string`, rather than to `number` and `Date`. The resolution of #5 records the mapping without a reason.
