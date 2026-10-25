---
status: proposed
---

# Renames declared with `renamedFrom`, and an opt-in casing that maps keys to SQL names

A column takes `.renamedFrom("old_name")` and a table takes `renamedFrom: "old_name"` in its second callback, and generate turns each into `ALTER ... RENAME` instead of a drop and create flagged as data loss. The marker is explicit, shows in git history, and does nothing once the Shadow database no longer holds the old name, so it can be removed later. `defineDatabase(schemas, { casing: "snake_case" })` maps schema, table, and column keys to SQL names, and keys stay verbatim by default, because the project is SQL-first and one name everywhere beats idiomatic TypeScript keys.

## Considered Options

- **A `--rename old:new` flag on generate (Prisma Next)**: the Current migration regenerates on every change until commit (ADR-0003), so the flag would have to be repeated on every run.
- **A hints file beside `current.sql` (Drizzle v1)**: survives regeneration, but puts the rename away from the column it renames.
- **A prompt at generate (Drizzle)**: ADR-0015 rejects prompts, since agents and CI would behave differently from people.
- **Hand-edited `RENAME` in `current.sql`**: works today, but a hand edit stops regeneration (ADR-0003).
- **snake_case by default**: idiomatic keys out of the box, but every query error and raw `sql` template then deals with two names. Breaking v0.1 names is acceptable before 1.0; it wasn't the reason.
- **Mapping result keys with a transform over every row (Kysely's `CamelCasePlugin`)**: covers raw `sql`, but rewrites keys inside user aliases and nested JSON. An alias helper for raw `sql` is deferred.
- **A marker on every renamed constraint and index**: explicit, but a renamed table would need one for each derived name.
- **Leaving derived names stale, as Postgres and pgroll do**: the catalog keys constraints by name, so a stale `users_pkey` on a renamed table shows as a diff on every generate.
- **Zero-downtime renames through two-version views (pgroll)**: out of scope for v0.2 and left for a later milestone.

## Consequences

- `renamedFrom` takes the old SQL name, as the Shadow holds it, not the old key, so it stays unambiguous when casing or a `.name()` override changes in the same step.
- Generate ignores a marker whose old name isn't in the Shadow, and throws when both the old and new names exist.
- A rename combined with another change, such as a new type, emits the `RENAME` first, then the other change with its own Hazards.
- Table and column renames carry a new `rename` Hazard, since app code still on the old name breaks between `migrate` and its deploy, so accepting it should be explicit. The `RENAME` itself only changes the catalog.
- Constraints, indexes, and identity sequences need no marker. Under one table, a dropped and an added one with identical payloads, compared after applying the declared renames, become one `RENAME CONSTRAINT`, `ALTER INDEX ... RENAME`, or `ALTER SEQUENCE ... RENAME`, with no Hazard. That keeps derived names from going stale and spares an index rebuild. More than one candidate falls back to drop and create.
- Without a marker, a renamed table or column stays a drop and create flagged as data loss. Generate prints a hint naming the `renamedFrom` to add when a table drops one column and adds one of the same type, or a schema drops a table and adds one with identical columns. It never writes a guessed rename into the SQL.
- Casing applies to schema, table, and column keys. Two keys that map to the same SQL name, such as `userId` and `user_id`, throw at load.
- A column takes `.name("sql_name")` and a table takes `name: "sql_name"` in its second callback, for a name casing can't produce. An explicit name always wins over casing, and constraint and index names given with `{ name }` stay verbatim.
- Derived names, such as `<table>_pkey`, `<table>_<columns>_key`, `_fkey`, `_idx`, and an identity's `_seq`, come from the mapped SQL names.
- Builder queries alias each output back to its key (`"email_address" as "emailAddress"`), as `select` already does for a picked alias. Raw `sql` returns the SQL names Postgres sends, typed as Driver rows.
- Enums and domains get `renamedFrom` only if the enums decision adds it. Schemas don't rename.
- Turning casing on for an existing database renames every name it changes, so each one needs its own marker.
