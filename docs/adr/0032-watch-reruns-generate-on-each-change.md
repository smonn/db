---
status: accepted
---

# Watch reruns generate on each change and logs append-only

`generate --watch` runs generate once at start and again after each change, loading the Definition in a fresh Worker per run and holding its locks only for the length of a run. Its log is append-only and never clears the screen, because a catch-up can apply data-loss Hazards and the scrollback has to keep them. A failed run keeps the last good Dev database and watch keeps going.

## Considered Options

- **Reload the Definition in the same process** by bypassing the import cache, as ADR-0014 expected: memory and modules would build up across runs, where a Worker keeps memory flat and carries no state.
- **Hold the locks for the whole session**: an idle watch would block `migrate`, `commit`, and `reset`.
- **Clear the screen on each run**: a tidier view, but it would erase an applied data-loss Hazard.

## Consequences

- A fresh Worker returns the Catalog and schema names. Watch puts a non-recursive watcher on each directory of the loaded module graph, rebuilt every run, plus the migrations folder, which it rescans after any event. Node 24 stays the floor.
- A run starts after 100 ms of quiet, with at most one rerun queued, and watch skips a `current.sql` event whose hash matches its own last write.
- Each run takes the Dev and migrator locks on a fresh session and releases them, so a dropped connection costs one run. A watcher lock on a third key refuses a second watcher at start, since a second watcher is almost always a forgotten terminal.
- A run that overlaps `commit` or `reset` fails on the Dev try-lock, and commit's writes then trigger a fresh run. Ctrl-C rolls back the current run and exits.
- A failed run prints its error and then `kept the Dev database from the <time> run`, and the next good run prints `ok fixed` so the recovery is visible. A strict refusal (ADR-0031) and a lock conflict both count as failed runs.
- Each run prints one line with the local time, `ok` or `failed`, the trigger path, and the duration, and its report sits indented under it. Start prints what it watches and `ok initial run`; Ctrl-C prints `stopped`.
- A run that changes nothing prints `ok no change`, because silence after a save reads as a hang, even though one-shot generate stays silent. Wording, colors, and the stdout and stderr split settle in implementation.
- A live pool in the app can still fail cached statements after a recreated domain. That limit gets a README note, not a watch feature (#623).
- `--json` prints watch as NDJSON events (ADR-0033).
