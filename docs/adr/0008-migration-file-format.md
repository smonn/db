---
status: accepted
---

# Migration file format, hash chain, and bookkeeping

Each Committed migration is one file named with a fixed-width sequence and a slug, such as `000001-create-users.sql`, holding two headers, `--! Previous: sha256:<hex>` (`-` for the first file) and `--! Hash: sha256:<hex>`, above plain SQL. The hash chain links each file to the one before it, so two branches that each add a Migration on top of the same tip fail loudly instead of applying in an order nobody tested. The format is our own rather than dbmate's or Graphile Migrate's, because following another tool binds the project to every change that tool makes; moving between tools is left to codemods.

## Considered Options

- **dbmate markers (`-- migrate:up`, `-- migrate:down`)**: lets dbmate run the files unchanged, but ties the format and its options to dbmate.
- **Graphile Migrate's headers with SHA-1**: same header syntax, but the files can't match Graphile byte for byte anyway, so SHA-1 buys nothing.
- **Hashing the filename too**: renaming a slug would break the chain.
- **Timestamped names without a chain (dbmate's default)**: parallel branches merge silently in whatever order git produces.
- **A lock table**: works beyond Postgres but leaves a stale lock when a process dies, which an advisory lock does not.

## Consequences

- The hash is SHA-256 over the previous hash (empty for the first file, as Git's root commit has no parent), a newline, and the body below the headers with CRLF turned to LF, trimmed, plus a trailing newline.
- The migrator records each run in `smonn_db.migrations (sequence integer primary key, filename text not null, hash text not null unique, previous_hash text references smonn_db.migrations (hash), applied_at timestamptz not null default now())`, creating the schema on first run. The schema name is configurable, and the Diff always skips it.
- In the dev Database, a one-row `smonn_db.current (hash text not null, applied_at timestamptz not null default now())` records the Current migration last applied, so generate can skip an unchanged reapply and notice a dev Database out of step with the file.
- Before applying anything, the migrator recomputes every hash, checks each Previous against the prior Hash, and requires the recorded rows to be a prefix of the file chain, refusing on any mismatch. There is no override for an edited Committed migration in v0.1.
- Each file runs in its own transaction together with its tracking row. In v0.1 every file is transactional, so `CREATE INDEX CONCURRENTLY` waits for a later `--! no-transaction` header.
- The migrator holds a session-level `pg_advisory_lock(76666326447283)` ("SMONNDBMIGRATE" on a phone keypad) on one connection for the whole run. A second instance waits, then finds nothing left to apply, and a crash rolls back the file in flight and releases the lock.
- Ejecting to dbmate means a codemod that adds its markers and backfills `schema_migrations`.
