---
status: accepted
---

# Migrations without a transaction

A Committed migration whose headers include `--! no-transaction` runs outside a transaction, so it can hold a statement such as `CREATE INDEX CONCURRENTLY`. Such a file holds one statement, so a failure leaves one shape to recover from: the statement ran, or it didn't. Its tracking row records `started` before the statement and `applied` or `failed` after, so the database shows how far a run got and what failed, not only the logs.

## Considered Options

- **Several statements per file, split by the migrator**: needs a SQL statement splitter (dollar quotes, comments, `BEGIN ATOMIC` bodies) in the runtime, and a failure halfway leaves many shapes to recover from.
- **Writing the tracking row only after the statement**: a crash leaves no trace in the database, and the error lives only in the logs.
- **Generate emitting `CONCURRENTLY`, or `current.sql` holding sections that `commit` splits into several files**: both are worth having later, but v0.2 starts with the simplest route.

## Consequences

- The header goes below `--! Hash`. The chain hash covers it: the previous hash, a newline, `--! no-transaction` and a newline when present, then the body. Adding or removing it on a Committed file changes how the file runs, so it must break the chain. Files without it keep their v0.1 hashes.
- Postgres enforces the one-statement rule, not our parser: it runs a script of several statements as one implicit transaction, so `CONCURRENTLY` in one fails with 25001.
- `smonn_db.migrations` gains `status text not null default 'applied'` (`started`, `applied`, or `failed`) and a nullable `error text`. The migrator adds both to an existing table with `add column if not exists`, and the constant default marks every v0.1 row `applied` without a backfill or a rewrite.
- A no-transaction file inserts its row as `started` in autocommit, runs the statement, then sets the row to `applied`, or to `failed` with Postgres's error message. A process that dies mid-statement leaves `started`. A transactional file still inserts its row as `applied` inside its own transaction and stores nothing when it rolls back.
- When the last recorded row is `started` or `failed`, `migrate` refuses before running anything, naming the file and the stored error. The fix is SQL: clean up, such as dropping the INVALID index a failed `CONCURRENTLY` leaves, then delete the row to retry; or set it to `applied` when the statement did finish. A command for this waits until someone needs it, since partial failures are rare.
- The migrator takes its advisory lock by polling `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`. A second instance blocked in `pg_advisory_lock` holds a snapshot that `CONCURRENTLY` waits on while it waits for the lock, and Postgres's deadlock detector kills it with 40P01. Polling keeps ADR-0008's promise that a second instance waits, then finds nothing left.
- In v0.2 a no-transaction file comes only from a hand-edited `current.sql`, and `commit` carries the header into the Committed file. `migrate`, the Shadow check of `current.sql`, and `reset` honor it; `reset` breaks its single replay transaction around such a file. A `current.sql` without the header runs in a transaction in the Shadow check, as it does in `migrate` and `reset`, so a statement that needs autocommit fails there unless the edit carries the header. Generate never emits `CONCURRENTLY` and never splits a diff across files, so changes that need two Committed files take two `commit`s.
- Generate keeps adding a foreign key with one `ADD CONSTRAINT` and its `share_row_exclusive_lock` Hazard (ADR-0019). A `NOT VALID` foreign key stays the same fact, and diff never emits `VALIDATE CONSTRAINT`, so it never validates a key someone left `NOT VALID` on purpose. Adding one `NOT VALID` and validating it later takes two hand-edited Committed files.
