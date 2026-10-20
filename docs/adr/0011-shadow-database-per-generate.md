---
status: accepted
---

# A fresh Shadow database for every generate

Each generate creates its own Shadow database with `CREATE DATABASE smonn_db_shadow_<unix seconds>_<8 hex> TEMPLATE template0` over the dev Database's connection, replays the Committed migrations into it, and drops it when done. A unique database per run means concurrent generates never share state and v0.1 needs no second connection string, which keeps the first version small; an override for hosts that deny `CREATEDB` can come later.

## Considered Options

- **One persistent, configured shadow (Graphile Migrate)**: needs its own connection string and a lock so two generates don't reset it under each other, and still needs `CREATEDB` to drop and recreate it.
- **An optional shadow URL beside the per-run default (Prisma)**: covers hosts without `CREATEDB`, but adds config and a reset-in-place path v0.1 doesn't need yet.
- **A separate cluster per run, such as a container**: isolates roles and other cluster-wide objects, at the cost of a heavy dependency.

## Consequences

- Generate needs `CREATEDB` on the dev connection's role, and fails with an error naming that privilege when it is missing.
- Generate connects to the shadow by swapping the database name in the dev connection URL.
- `finally` and SIGINT and SIGTERM handlers drop the shadow. A SIGKILL or lost connection leaves it behind, so every generate first drops `smonn_db_shadow_*` databases older than one hour that have no sessions in `pg_stat_activity`, using `DROP DATABASE ... WITH (FORCE)`, and logs each name. The age comes from the name, and the age check spares a concurrent run's live shadow.
- Roles and tablespaces outlive the shadow, so a Committed migration that creates one fails on the next replay unless it is idempotent. The docs ask for idempotent cluster-wide statements and show a `DO` block guard for `CREATE ROLE`, which has no `IF NOT EXISTS`; replay maps the duplicate-object error to a message linking that doc.
- Replay keeps Postgres's default `check_function_bodies = on`. The Committed migrations already passed with it in this order, and it catches a SQL function that names a missing table or column.
