---
status: proposed
---

# Reset only a marked Dev database

Generate and `reset` drop every non-system schema, so they run only in a Database that has the `smonn_db.current` table or holds no non-system schema yet, and anything else needs one deliberate `reset --erase`. Generate and `reset` create `smonn_db.current` and the runtime migrator never does, so a production URL in the config refuses instead of losing its data.

## Considered Options

- **`--erase` on every destructive run**: always safe, but generate resets on most runs and would need the flag each time.
- **Trusting the config's URL**: one mistyped environment variable destroys a production Database.

## Consequences

- `reset --erase` creates `smonn_db.current`, which marks an existing Database as a Dev database.
- The runtime migrator (ADR-0007) refuses when `smonn_db.current` holds a row and Committed migrations are pending, because running them on top of an applied Current migration can fail or diverge. With nothing pending it does nothing, so app startup in dev keeps working.
- Generate, `commit`, and `reset` share a `pg_try_advisory_lock` on the Dev database, under a key apart from the migrator's, and a second run fails at once instead of waiting. Failing fast gives quick feedback, which matters when several agent sessions share one Dev database.
