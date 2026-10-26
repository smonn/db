---
status: accepted
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
- **Rewriting references to a renamed object in the Shadow's catalog**: works for foreign key targets and column types, but a renamed type or label also appears inside deparsed expressions (`'happy'::d.mood` prints as `'glad'::d.mood`), and substituting strings in SQL text is fragile.
- **Deferring enum renames**: a label rename is the common, cheap case, such as a typo fix. `RENAME VALUE` runs in place and locks no table, while without it the fix becomes the type swap, rewriting every table that uses the enum under `data_loss`.
- **Label markers inline in the list** (`["sad", { label: "great", renamedFrom: "good" }]`): `defineEnum` infers its union from a const string tuple, and objects in it would complicate that and the label check for a temporary marker.
- **Zero-downtime renames through two-version views (pgroll)**: out of scope for v0.2 and left for a later milestone.

## Consequences

- `renamedFrom` takes the old SQL name, as the Shadow holds it, not the old key, so it stays unambiguous when casing or a `.name()` override changes in the same step.
- Generate ignores a marker whose old name isn't in the Shadow, and throws when both the old and new names exist.
- A rename combined with another change, such as a new type, emits the `RENAME` first, then the other change with its own Hazards.
- Table and column renames carry a new `rename` Hazard, since app code still on the old name breaks between `migrate` and its deploy, so accepting it should be explicit. The `RENAME` itself only changes the catalog.
- Generate runs the declared renames on the Shadow database inside a transaction, introspects it, and diffs the rest against that catalog, then rolls back, so verification (ADR-0013) still applies the whole migration. Postgres follows a rename by OID everywhere, including the expression text of defaults, checks, index expressions, `WHERE` predicates, and generated columns, so the same server rewrites every reference. A marker whose old name is gone is skipped, under the ignore-or-throw rule.
- Constraints, indexes, and identity sequences need no marker. Under one table, a dropped and an added one with identical payloads become one `RENAME CONSTRAINT`, `ALTER INDEX ... RENAME`, or `ALTER SEQUENCE ... RENAME`, with no Hazard. That keeps derived names from going stale and spares an index rebuild. More than one candidate falls back to drop and create.
- Without a marker, a renamed table or column stays a drop and create flagged as data loss, and a renamed label stays the type swap (ADR-0023). Generate prints a hint naming the `renamedFrom` to add when a table drops one column and adds one of the same type, or a schema drops a table and adds one with identical columns, and the `renamedLabels` entry to add when an enum removes one label and adds one at the same position. It never writes a guessed rename into the SQL.
- Casing applies to schema, table, column, enum, and domain keys. Enum labels never map, and domain check keys stay verbatim like other explicit constraint names. Two keys that map to the same SQL name, such as `userId` and `user_id`, throw at load, a table and a type included, since they share a schema's names.
- A column takes `.name("sql_name")`, a table takes `name: "sql_name"` in its second callback, and an enum or domain takes `name` in its options, for a name casing can't produce. An explicit name always wins over casing, and constraint and index names given with `{ name }` stay verbatim.
- Derived names, such as `<table>_pkey`, `<table>_<columns>_key`, `_fkey`, `_idx`, and an identity's `_seq`, come from the mapped SQL names.
- Builder queries alias each output back to its key (`"email_address" as "emailAddress"`), as `select` already does for a picked alias. Raw `sql` returns the SQL names Postgres sends, typed as Driver rows.
- `defineEnum` takes a second argument, `{ renamedFrom: "old_mood", renamedLabels: { great: "good" } }`, keyed new to old like `renamedFrom`, and `defineDomain` takes `renamedFrom` in its existing options. They emit `ALTER TYPE ... RENAME TO`, `ALTER TYPE ... RENAME VALUE`, and `ALTER DOMAIN ... RENAME TO`, each with the `rename` Hazard, since raw `::mood` casts and code writing `'good'` break too. Their markers follow the same ignore-or-throw rule as a column's. Domain checks rename by payload match with no Hazard, like constraints. Schemas don't rename.
- Turning casing on for an existing database renames every name it changes, so each one needs its own marker.
