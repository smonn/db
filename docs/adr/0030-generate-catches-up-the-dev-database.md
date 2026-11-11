---
status: proposed
---

# Generate catches up the Dev database and keeps its data

Generate used to reset the Dev database whenever the Current migration or the Committed tip changed, so every Definition edit cost the user their dev data and watch would have wiped it on every save. Generate now catches the Dev database up in place: with no Current migration recorded and a recorded chain that prefixes the Committed chain it replays the new files as written, and otherwise it diffs the Dev database against the Shadow and names the files that skipped replay. Replay is exact, so it goes first, and the diff covers what replay can't; watch has to keep data across runs, and a reset on each save cannot.

## Considered Options

- **Keep resetting**: exact after any hand edit or branch switch, but it throws away dev data on most runs.
- **Reset when a catch-up fails**, or behind a force flag: the Dev database would recover without the user noticing, and the user would lose data they never agreed to give up. A visible failure that names `reset` beats a silent wipe.

## Consequences

- A catch-up step that loses data applies anyway and prints its Hazards, because a Definition edit that drops a column should drop it in the Dev database too.
- The steps, the marker writes in `smonn_db`, and a zero-diff check run in one transaction. A nonzero diff or a failure rolls all of it back, so the Dev database stays as it was, as #245 requires of a failed replay.
- The Shadow holds the Current migration, generated or hand-edited, when generate diffs, and the diff and the zero-diff check both compare against it rather than the Definition, because `smonn_db.current` records the file and commit trusts that record.
- Matching markers mean no work. Commit's full-chain predicate picks the path and covers #643's `needsReset` check.
- A no-transaction file, a missing migrations table, and a last row left `started` or `failed` take the diff path. Only a Database with no tracking tables, which holds nothing to keep, resets on a first run.
- The diff runs no statement from a skipped file, so a rename or backfill that a Committed or hand-edited file did by hand, and the Definition no longer declares, lands as a drop and an add with a `data_loss` Hazard.
- Generate prints one outcome line (`none`, `reset`, `replayed`, or `diffed`, with the files and any applied Hazards) and nothing on a run that changes neither `current.sql` nor the Dev database. Watch prints `ok no change` itself (ADR-0032).
- `reset` is the only way to rebuild a Dev database that holds data, and ADR-0016's marker rule still applies to it.
- `--json` reports the outcome as `devDatabase` (ADR-0033).
