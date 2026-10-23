---
status: proposed
---

# Generate diffs two introspected databases

Generate runs the Definition's DDL in a throwaway Definition database and introspects it with the same `pg_catalog` queries it runs on the Shadow database, so the diff compares two catalogs that Postgres normalized itself instead of a TypeScript guess at how Postgres stores each type and default. Before writing the Current migration, generate applies the generated body to the Shadow, introspects again, and requires no difference from the Definition database. When `current.sql` is hand-edited, generate runs the edit in the Shadow instead. One more `CREATE DATABASE` per run keeps the diff accurate whatever the Postgres version, because the same server deparses both sides, and the verification stops a broken migration before it reaches real data. On generated SQL it should never fail by itself; an Unmodeled object can still block it.

## Considered Options

- **Convert the Definition straight into the catalog**: saves the second database, but a normalizer has to match Postgres's deparsed text for every default, type alias, and identity sequence, and Atlas's `diff.go` shows how much code that takes.
- **No verification**: one step fewer, but a migration that doesn't converge only shows up as a leftover diff on the next generate.
- **Find blockers in `pg_depend` while generating**: reports every Unmodeled object in the way before any SQL runs, but needs code to map its rows back to catalog paths, while Postgres already refuses the same changes during verification.

## Consequences

- The Definition database reuses ADR-0011's lifecycle under the prefix `smonn_db_definition_`, and the start-of-run sweep covers both prefixes.
- Generated SQL never uses `CASCADE`. When an Unmodeled object depends on a changed table or column, Postgres refuses during verification (`2BP01` on a drop, or the error for altering a column a view uses), and generate maps the error to a message naming the object and suggesting a hand edit. For a hand-edited file, the message points at fixing the Current migration instead of suggesting a hand edit. ADR-0005 holds even when a change touches an Unmodeled object.
- A SQL error in a hand edit fails the run before the Dev database is touched. A leftover difference from the Definition prints as a warning, and the run succeeds. A hand edit is the user deliberately diverging from the Definition, often to get around an Unmodeled object, so failing on it would close the way out this ADR points to. The leftover still shows as a diff on the next generate. A strict mode that fails on leftovers waits for v0.4's strict hazard mode.
- Postgres records no dependency for references inside a string function body, so a hand-written function that reads a dropped column passes verification and breaks when called.
- Materialization keeps `check_function_bodies = on`. v0.1's Definition creates no functions; revisit once it can.
- The engine's tests run the same check over a corpus of before and after pairs, instead of asserting SQL strings.
