# Prior art for keeping dev data and watch mode

Research for #766, under the v0.4 map #765. It feeds three grilling tickets: #768 (catch-up that keeps data), #770 (watch mode), #771 (`--json`). It decides nothing. Every fact cites a primary source: official docs, source code at a pinned commit, or a changelog. Anything I could not confirm sits under [Unverified](#unverified).

Read first: `docs/architecture/cli.md` (Hand edits, Dev database catch-up), ADR-0003, ADR-0013, ADR-0016, and `GLOSSARY.md`.

## Summary

- Only Graphile Migrate replays a hand-written file against the same database on every save, and it never resets by itself. It keeps data only because the author writes undo steps into the file.
- Atlas (`schema apply`), Drizzle (`push`), Prisma (`db push`, Prisma 8 `db update`), and migra all diff the live database against the new schema. That is how they keep data. They differ in what they do with a change that cannot keep it: refuse, ask, truncate, or reset.
- On a history that no longer matches the Dev database, Prisma 7 `migrate dev`, Atlas, and Graphile Migrate tell the user to reset or clean. Prisma 8 (a release candidate) removes reset and moves the live database instead.
- No tool here watches the schema and updates a Dev database. Graphile Migrate watches its Current migration. Prisma and Drizzle watch only for client or contract generation.
- Machine output is rare and recent. Atlas prints Go-template JSON. Prisma 8 and Drizzle 1.0 (both release candidates) print one JSON document per command and answer "needs a decision" with a structured result. None of them stream NDJSON events.

## Terms and versions

Atlas calls its throwaway replay database the `dev-url` database. That is this repo's Shadow database, not the Dev database ([Atlas docs, dev-url][atlas-dev]). Prisma's Shadow database is also ours ([Prisma Shadow database][prisma-shadow]). The Dev database here is the one a developer works against: Atlas's local target, Prisma's development database.

| Tool               | Version read                                                     | Notes                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graphile Migrate   | `main` at `2cfadbb`, latest release v1.4.1 ([releases][gm-rel])  |                                                                                                                                                                |
| Atlas              | docs on atlasgo.io, open source at `90dacfc`                     | The closed-source binary may differ from the open source tree.                                                                                                 |
| Prisma 7           | 7.10.1, the latest stable ([releases][prisma-rel])               | Engine code from `prisma-engines` at `d1b3f37`.                                                                                                                |
| Prisma 8           | 8.0.0-rc.22, a prerelease ([releases][prisma-rel])               | First-party `skills/prisma-8` references and ADRs at `a405bd9`. The default docs site now mixes Prisma 7 and Prisma 8 pages ([team development][prisma-team]). |
| Drizzle Kit stable | 0.31.11 at `15454db` ([releases][drizzle-rel])                   | `main` holds this version.                                                                                                                                     |
| Drizzle Kit 1.0    | v1.0.0-rc.5 at `5d71fc4`, a prerelease ([releases][drizzle-rel]) | The docs page for `push` already describes this version (`--explain`, `mssql`).                                                                                |
| migra              | `master` at `345038271`                                          | Deprecated, last release in Sept 2022 ([README][migra-readme]).                                                                                                |

## Graphile Migrate

### What `watch` does with `current.sql`

- `watch` first runs any Committed migrations the database has not run, then creates `current.sql` if missing, then runs it on each change ([watch.ts L44-L57][gm-watch-start]).
- It watches `current.sql` and the `fixtures` folder with chokidar polling on, and a `change`, `add`, or `unlink` event queues a run ([watch.ts L15-L37, L85-L92][gm-watch-opts]).
- Debounce: `awaitWriteFinish` waits for a 200 ms stable size, polled every 100 ms. The code comment gives the reason: some editors write in pieces. Polling is on because `git stash && sleep 2 && git stash pop` otherwise stops the watcher on Linux ([watch.ts L15-L37][gm-watch-opts]).
- Overlap: one run at a time. An event during a run sets `runAgain`, and exactly one more run starts when the first ends ([watch.ts L59-L84][gm-watch-queue]).
- A run compares the minified, compiled body with the body stored in `graphile_migrate.current`. Equal bodies skip the run with "current.sql unchanged, skipping migration" ([currentRunner.ts L66-L78, L121-L125][gm-runner-compare]).
- On a difference it calls `reverseMigration`, which is a stub. Its body is `// TODO: reverse the migration` plus a delete of the tracking row ([migration.ts L662-L672][gm-reverse]). It commits that, then runs the whole file again in a new transaction ([currentRunner.ts L90-L120][gm-runner-rerun]). The file is rerun, never diffed.

### What it asks of the file

- The README says the Current migration "should be idempotent (this is your responsibility)" and calls that "critical for `graphile-migrate watch`" ([README L161-L164][gm-readme-idem]).
- The recipe is `drop ... if exists` and `create or replace`, or an explicit undo block ahead of a redo block. `DROP ... CASCADE` is advised so parallel work needs no extra undo ([README L664-L705][gm-readme-idem2]).
- Data is lost whenever the undo drops a table or column. The README accepts this: branch switching works "other than the implicit data loss of dropping tables/columns/etc" ([README L651-L656][gm-readme-collab]).
- Without undo steps the database drifts. Renaming a function in `current.sql` leaves the old one behind, and the README says it is "up to you to make the SQL safe". It recommends against auto-save for this reason ([README L874-L929][gm-readme-drift]).

### When it resets

- `watch` never resets the Dev database. `reset` is a separate command that drops and recreates the database, and it refuses without `--erase` ([reset.ts][gm-reset]). `commit` resets the Shadow database ([README L186-L188][gm-readme-usage]), and so does `uncommit` ([README L126-L130][gm-readme-root]). This matches ADR-0016's guard, with an explicit flag instead of a marker table.
- README: "Resetting development database is acceptable if absolutely necessary", and a non-linear commit "may lead to you resetting your development database" ([README L56-L57][gm-readme-goals], [L658-L662][gm-readme-collab]).

### A pulled or switched history

- `migrate` takes the last row of `graphile_migrate.migrations` by filename and runs every Committed migration file sorted after it ([migrate.ts L36-L59][gm-migrate], [migration.ts L538-L548][gm-after]). Before that it checks the hash chain of the files: a missing predecessor or a `Previous` hash mismatch throws ([migration.ts L517-L533][gm-chain]).
- Nothing compares the database's recorded rows with the files beyond "later than the last row". A database that ran a Committed migration which is no longer on disk goes unnoticed. This is my reading of those functions, not a documented behavior.
- A pulled Committed migration runs on top of whatever the old `current.sql` already did, since the reverse step is a stub. Whether that fails depends on the file being idempotent. Also my reading.

### Failure, recovery, and machine output

- A failed run rolls back its transaction ([migration.ts L562-L604][gm-runstring]). The tracking row was already deleted and committed, so the next run reruns the file even when its text is unchanged. My reading of [currentRunner.ts L90-L120][gm-runner-rerun].
- The error prints with the line and column and the code line above it, in red, then Postgres `Severity`, `Code`, `Detail`, `Hint` ([instrumentation.ts L17-L104][gm-instr]). `watch` catches it and keeps watching ([watch.ts L68-L76][gm-watch-queue]).
- The next good run prints `[<ISO time>]: Running current.sql`, then `Finished (<n>ms)`. There is no separate "recovered" line ([currentRunner.ts L28-L31, L152-L160][gm-runner-rerun]).
- No JSON. `status` exits with a bitmap: 1 for Committed migrations not yet run, 2 for a non-empty Current migration, 3 for both ([status.ts L70-L77][gm-status]).

## Atlas

### Declarative path: diff the live database

- `schema apply` loads the desired state into the `dev-url` database, inspects the live database, plans the change, shows the SQL, and asks for approval ([declarative apply][atlas-apply]). `--dry-run` prints the plan. `--auto-approve` skips the prompt.
- No Atlas command replays history onto the Dev database and compares. The Dev database either takes `schema apply` or takes `migrate apply` (below).
- Data it cannot keep: Atlas does not truncate or reset. It warns. The `destructive` analyzer flags a dropped schema (DS101), table (DS102), or column (DS103). The `data_depend` analyzer flags changes that may fail on existing rows, such as a non-nullable column on a non-empty table (MF103) ([lint analyzers][atlas-lint]). The analysis runs on the `dev-url` database during review, and a `diff` policy can skip `DROP TABLE` or `DROP SCHEMA` statements ([declarative apply][atlas-apply]). Whether lint checks real row counts in the live database is not stated.

### Versioned path: replay and revisions

- `migrate apply` records runs in `atlas_schema_revisions` and runs every file not yet recorded ([versioned apply][atlas-versioned]).
- `migrate diff` replays the directory onto the `dev-url` database, compares it with the desired state, and writes a file ([versioned diff][atlas-diff]).
- Atlas's source finds the next file from the last revision's version, then handles older unrecorded files by `--exec-order`: `linear` (default) fails with `HistoryNonLinearError`, `linear-skip` skips them, `non-linear` runs them ([migrate.go L735-L790][atlas-pending], [versioned apply][atlas-versioned]). A partly run revision whose file is gone raises `MissingMigrationError` ([migrate.go L741-L757][atlas-pending]). A revision the files no longer mention, and that is not partly run, raises nothing: my reading of that code.
- `atlas.sum` hashes the directory. A mismatch is reported on the next command. Two branches that each add a file conflict in `atlas.sum`, and the fix is to merge, `atlas migrate rebase` your file if it is not the latest, then `atlas migrate hash` ([directory integrity][atlas-integrity]).

### A pulled or switched history

- For local development the docs suggest `--exec-order non-linear` when the remote changes do not conflict with local ones. When they do conflict, clear the database with `atlas schema clean` and adjust the local changes ([versioned apply][atlas-versioned]). That is a reset, offered as the recovery. `schema clean` takes `--dry-run` and `--auto-approve` ([CLI reference][atlas-cli]).
- A failed file rolls back its transaction by default (`--tx-mode file`). With `--tx-mode none` Atlas resumes at the failed statement on the next attempt. On MySQL, implicit commits can leave a mismatched state ([versioned apply][atlas-versioned]).

### Watch mode and machine output

- No watch mode. `atlas schema apply` and the other commands list no watch flag ([CLI reference][atlas-cli]), and I found no watch code in the open source tree. A search of atlasgo.io found only cloud schema monitoring, which is a scheduled check of a database, not a local watcher ([monitoring][atlas-monitor]).
- `--format '{{ json . }}'` renders the result of `migrate apply` as JSON: `Driver`, `URL`, `Dir`, `Pending[]`, `Applied[]` with each file's executed statements, `Target`, `Start`, `End`, and `Message`. A failed statement adds an `Error` object to its file with the statement and error text ([versioned apply][atlas-versioned]). `schema apply` reports `Applied`, `Plan`, and `Changes` with `Pending` and `Error` entries ([declarative apply][atlas-apply]).
- `--format` is a Go template, so the caller chooses the shape. `migrate status` takes it, but its JSON fields are undocumented ([CLI reference][atlas-cli]).
- Lint fails with exit code 1 when it finds destructive changes ([lint analyzers][atlas-lint]).

## Prisma

### 7.x `migrate dev`: replay and reset

- `migrate dev` starts with `devDiagnostic`. The engine builds a fresh Shadow database from the history, introspects it, and compares it with the Dev database ([Shadow database][prisma-shadow]).
- The engine proposes a reset for each of these: a migration that failed, a migration edited after it ran, schema drift, history that diverges from the directory, and a directory that is behind the database ([dev_diagnostic.rs L64-L117][prisma-devdiag]).
- In 7.10.1 `migrate dev` then prints the reasons and `We need to reset the "<schema>" schema`, tells the user to run `migrate reset`, prints "All data will be lost.", and exits 130. It does not reset or prompt there ([MigrateDev.ts L170-L184][prisma-dev-reset]). The older docs page says it prompts ([prototyping][prisma-proto]). The source and the page disagree, and I did not run it.
- With no reset condition it runs the migrations not yet run, evaluates data loss, and stops on steps it cannot execute. It prompts on warnings unless `--force`, and in a non-interactive shell it throws ([MigrateDev.ts L207-L258][prisma-dev-loss]). It then writes and applies one new migration, named by the user ([MigrateDev.ts L260-L296][prisma-dev-create]).

### 7.x `db push`: diff the live database

- `db push` ignores the history and the `_prisma_migrations` table ([prototyping][prisma-proto]). It introspects the live database, diffs it against the schema, runs the destructive-change checker, and applies the steps ([schema_push.rs L38-L65][prisma-push-engine]).
- It runs when there are no warnings. With warnings it needs `--accept-data-loss`. An unexecutable step aborts and suggests `--force-reset` ([DbPush.ts L187-L214][prisma-push-cli]).
- With warnings and no flag it prompts, and a non-interactive shell throws ([DbPush.ts L216-L255][prisma-push-cli]). `--force-reset` resets the database first ([DbPush.ts L146-L182][prisma-push-reset]).
- Exit 130 follows a refusal at the prompt, which Prisma says signals cancellation ([DbPush.ts L237-L242][prisma-push-cli]).
- `db push` and `migrate reset` call `aiAgentConfirmationCheckpoint` before a reset or a data-losing push. A detected AI agent gets an error telling it to stop, ask the user, and rerun only with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to the user's exact consenting message ([ai-safety.ts][prisma-ai]).

### 8 (release candidate): move the live database, never reset

- Prisma 8 has no `db push` for production ([ADR 287][prisma-adr287]) and no reset at all. "No recovery resets or drops a database" ([ADR 307][prisma-adr307]) rules out recommending one, because "A reset loses data that no migration needs to lose" and an agent that has run out of ideas reaches for it.
- `db update` diffs the live database against the contract, runs the plan, and signs the database. It writes no migration. It excludes data transforms and refuses `--convert` and `--backfill` ([migrations.md L34, L154-L176][prisma8-migrations]).
- Before it loses data, `db update` asks one question per subject. The answers are `--delete <subject>` or `--rename <subject>:<new name>`. With nobody to answer (`--no-interactive`, CI), it fails with `CLI.CONSENT_REQUIRED`, listing the unanswered subjects and the flags that answer them ([migrations.md L550-L567][prisma8-consent]). `--dry-run` asks nothing and lists the questions ([migrations.md L154-L156][prisma8-migrations]).
- A database records the contract hash it is at in a marker (`prisma_contract.marker` on Postgres). A marker outside the migration graph, for example after a rebase deleted a migration the database had run, fails with `MIGRATION.MARKER_MISMATCH`. The error's next step is `db update`, and it says the data stays ([ADR 307][prisma-adr307]).
- The `db` ref (`migrations/app/refs/db.json`) stores the contract hash the Dev database was last brought to, so `migration plan` knows where to start ([migrations.md L97-L130][prisma8-ref]). A conflict in that file after a merge is expected. Take either side and let the next run rewrite it ([team development][prisma-team]).
- One `db migrate` run is a single Postgres transaction, so a failure rolls the whole run back ([migrations.md L49][prisma8-migrations]).

### Watch and machine output

- `migrate dev` has no watch. `prisma generate --watch` watches the schema folder and regenerates the client ([Generate.ts L286-L345][prisma-gen-watch]). It uses chokidar with `ignoreInitial` and no debounce, and an async queue runs one regeneration per event in order ([Watcher.ts][prisma-watcher]).
- On failure it appends the error to a log string and redraws "Watching...". The string is only ever appended to in that loop, so I read this as an error that persists across later good runs. Not run ([Generate.ts L337-L343][prisma-gen-watch]).
- Prisma 8's Vite plugin re-emits the contract on change, with `debounceMs` defaulting to 150 ms. It logs `[prisma] emitted contract.d.ts + contract.json` on success and shows emit errors in the Vite overlay ([build.md L40-L75, L117][prisma8-build]). It watches the inputs of the contract, not the database.
- Prisma 7 has no JSON for `migrate dev`, `db push`, or `migrate status` that I could find in their source. `migrate status` exits 1 when not in sync, `migrate diff --exit-code` exits 0, 1, or 2, and cancellation exits 130 ([MigrateStatus.ts L146-L172][prisma-status], [MigrateDiff.ts][prisma-diff]).
- Prisma 8 puts `--json` and `-v` on every CLI command. A failure is an envelope with `ok`, `code`, `severity`, `summary`, `why`, `fix`, `nextActions`, `where`, `meta`, and `docsUrl`. Exit 2 means the command could not run, 3 a user abort, and 4 "ran and found something". `migration status` exits 0 even with `warn` diagnostics, so the doc says to route on severity and code together ([debug.md L23-L44, L60-L62][prisma8-debug]). `db update --json` returns `plan.operations[]` with an `operationClass` (`additive`, `widening`, `data`, `destructive`), and in apply mode `execution.operationsExecuted` and `marker.storageHash` ([migrations.md L170-L176][prisma8-migrations]).

## Drizzle

### `push`: diff the live database

- Docs: `push` reads the TypeScript schema, introspects the database, computes the difference, and applies SQL. Its flags are `verbose`, `explain` (dry run), and `force` ("auto-accept all data-loss statements") ([push docs][drizzle-push]). `push` is described as "the best approach for rapid prototyping", and the migrations page does not say whether `push` touches the migrations folder ([migrations docs][drizzle-migrations]). The code of the stable Postgres path, and of 1.0, reads no migrations folder; see [Unverified](#unverified).
- Data it cannot keep, stable 0.31.11: before a change that may lose rows, it runs `select count(*)` on the table, and if rows exist it asks. Its prompt reads "Found data-loss statements ... THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED". For a column type change on a non-empty table it adds `truncate table ... cascade` to the plan, and a primary key change also marks the table for truncation ([pgPushUtils.ts L136-L171][drizzle-stable-utils]).
- Drizzle Kit 1.0: it counts rows only to decide whether a drop needs confirmation. A drop of a table, a materialized view, a schema, or a primary key, or of a column holding a non-null value, asks only when rows exist. Otherwise it applies silently ([push-postgres.ts L224-L290][drizzle-rc-suggest]). Renames: it asks "rename or create" per entity through the same hint mechanism ([hints.ts][drizzle-hints]).
- `--strict` always asks for confirmation ([schema.ts L554][drizzle-rc-push]).
- In 1.0 the Postgres code skips changes to a view's definition, and a comment calls a Shadow database "the most reasonable way" to handle them reliably ([push-postgres.ts L198-L208][drizzle-rc-suggest]).

### A pulled or switched history

- `push` does not look at the migration history in the code read here. Branch divergence only matters for `generate`: `drizzle-kit check` verifies the history is consistent, with a commutativity check skippable by `--ignore-conflicts` ([check docs][drizzle-check]). 1.0 has `generate --fix-conflicts` for Postgres ("delete the conflicting migrations and their children, then generate one new migration") ([schema.ts L364-L366][drizzle-rc-gen]). The docs page for `check` does not mention it.

### Watch and machine output

- No watch mode in Drizzle Kit. The push docs do not mention one and `schema.ts` has no watch option ([push docs][drizzle-push]).
- Stable 0.31.11 has no JSON output: neither `schema.ts` nor `views.ts` at that tag mentions JSON.
- 1.0 adds `--output text|json` (default text), `--hints '<json array>'`, `--hints-file`, and `--explain` to `push` and `generate` ([schema.ts L345-L350, L545-L566][drizzle-rc-opts]).
- In JSON mode the command writes one line, `JSON.stringify(envelope)` plus a newline, then exits ([schema.ts L572-L577][drizzle-rc-push]). `status` is `ok`, `no_changes`, `missing_hints`, or `error`, with exit codes 0, 0, 2, 1 ([schema.ts L57-L80][drizzle-rc-exit]).
- With JSON on, or without a TTY, the command never prompts. Where a person would be asked, it returns `status: "missing_hints"` and an `unresolved` array. Each entry is either `rename_or_create` or `confirm_data_loss` with a `kind`, an `entity` tuple, and a `reason` (`non_empty`, `table_recreate`, or `type_change`). The caller reruns with `--hints` answering each one ([hints.ts L295-L300][drizzle-hints], [push-postgres.ts L188-L190][drizzle-rc-suggest]).
- `--explain --output json` returns `{status:"ok", dialect, statements, hints}` ([views.ts L877-L888][drizzle-rc-explain]).

## migra

- migra compares two live databases and prints the SQL that turns the first into the second: `migra postgresql:///a postgresql:///b` ([README][migra-readme]). It keeps no history. It is the plain "diff the live database" case.
- It refuses data loss by default. `Statements.sql` raises when any statement matches `drop\s+` and the command prints "destructive statements generated. Use the --unsafe flag" to stderr and exits 3. `--unsafe` lets the drops through ([statements.py][migra-statements], [command.py][migra-command]). The check is a regex over the SQL text, so it knows nothing about row counts.
- Exit codes are 0 for no difference, 2 for a difference, and 3 for refused drops. Output is SQL on stdout, with no JSON ([command.py][migra-command]).
- No watch mode, no history, no handling of pulled migrations. The README calls the project deprecated and names `results` as its successor ([README][migra-readme]). I did not read `results`.

## Findings by the Done-when bullets

1. Graphile Migrate `watch`: rerun the file on every save, a one-run queue, a 200 ms write-stability wait, idempotent SQL by the author, no reset. See [Graphile Migrate](#graphile-migrate).
2. Bringing the Dev database to a new schema. Replay: Graphile Migrate, and Atlas and Prisma 7 for history, which reset on conflict. Diff the live database: Atlas `schema apply`, Prisma `db push` and 8's `db update`, Drizzle `push`, migra. Reset: Prisma 7 `migrate dev` on drift, `db push --force-reset`. Data it cannot keep: refuse (migra, Atlas lint, Prisma `unexecutable`), ask (Prisma, Drizzle), truncate after asking (stable Drizzle), per-subject answers (Prisma 8), or reset (Prisma 7).
3. A history that no longer matches: Prisma 7 and Atlas end in a reset or a clean. Graphile Migrate runs what it finds and may fail. Prisma 8 moves the live database. Drizzle `push` and migra ignore history.
4. Watch: Graphile Migrate is the only schema-to-database watcher. Prisma `generate --watch` and Prisma 8's Vite plugin watch for code generation. Atlas, Drizzle Kit, and migra have none.
5. Machine output: Atlas (`--format` Go template), Prisma 8 (`--json` envelope), Drizzle 1.0 (`--output json`, one line, `missing_hints`). Graphile Migrate, Prisma 7, stable Drizzle, and migra emit none, only exit codes.

## Unverified

- I ran none of these tools. Every behavior above is from docs or source, except where marked "my reading".
- Atlas: no watch mode is a negative finding from the docs, the CLI reference, and the open source tree. The released binary may have something the open tree lacks. How `migrate status` formats JSON is undocumented.
- Atlas lint and live data: I could not tell whether Atlas reads row counts from the live database or flags by statement kind alone. The docs describe analysis on the `dev-url` database.
- Prisma 7: the docs page says `migrate dev` prompts before a reset, while 7.10.1 source prints and exits 130. I did not find which is current in practice.
- Prisma 8 and Drizzle 1.0 are release candidates. Their flags, envelopes, and ADRs may change before release.
- Prisma 8 JSON: I read the documented envelope from first-party skill docs, not the TypeScript type or a run.
- Drizzle `push` and history: I read the stable and 1.0 Postgres push code and found no migrations-folder read. I did not read the whole call graph.
- Drizzle 1.0 data loss for column type changes: `ConfirmDataLossReasonDetails` lists `type_change` and `table_recreate`, but the push function I read only asks for drops and a primary key drop. The reason may arrive through the diff step. Not traced.
- Graphile Migrate: the "pulled migration runs on top" and "unrecorded revision goes unnoticed" statements are my reading of the code, not a documented behavior. Same for Atlas's unrecorded revision.
- `prisma generate --watch`: that an error persists on screen after a good run is my reading of `logText` handling.
- migra's successor `results`: not read.

## Open questions

### For #768, catch-up that keeps data

1. What does catch-up diff? Every diffing tool above compares the live database with a target. For us that is the Dev database's catalog against either the Definition database or the Shadow database with the Current migration applied. A hand-edited `current.sql` (cli.md, Hand edits) points to the second. No tool here diffs against a hand-edited file; only Graphile Migrate runs one.
2. What does a hand edit do on a live diff? If catch-up diffs catalogs, data statements in a hand-edited `current.sql`, such as a backfill, never run on the Dev database. Prisma 8's `db update` states this limit and refuses data transforms. Should catch-up refuse, warn, or replay the file in that case?
3. What does catch-up do with a change that cannot keep the data? The options seen are refuse (migra, Prisma `unexecutable`), ask (Drizzle, Prisma), truncate after asking (stable Drizzle), per-subject answers (Prisma 8), reset (Prisma 7, Atlas `schema clean`, Graphile Migrate `reset --erase`). Is the Hazard model (ADR-0015, `--accept <kind>`) the answer channel, with a reset as the fallback only for hazards the user did not accept?
4. Does it need row counts? Drizzle asks only when a table holds rows; Atlas and migra decide by statement kind. Asking by kind keeps catch-up deterministic. Asking by rows spares an empty dev table the prompt.
5. How does catch-up know the Dev database is what `smonn_db.current` and `smonn_db.migrations` say? Prisma 7 compares a replayed Shadow database with the live catalog. Prisma 8 trusts a marker hash. Graphile Migrate trusts neither. The hash plus tip check in cli.md trusts the markers. Is a catalog comparison worth its cost, given that live diffing would make drift harmless for most changes?
6. After a branch switch, is catch-up the same operation as after an edit? A live diff turns a pulled Committed migration, a dropped one, and an edit into one forward move, and ADR-0003's forward-only history stays intact. Prisma 8 does this and calls the result safe because data stays. What does the Hazard report print for a diff that goes "backward", such as dropping a column the other branch added?
7. Is one transaction per catch-up the rule? Graphile Migrate rolls back per file, Prisma 8 runs one transaction per `db migrate`, Atlas defaults to one per file. What state do `smonn_db.current` and `smonn_db.migrations` hold after a failed catch-up, and does the failed run leave the Dev database on its last good state?
8. Does catch-up still need a force-reset flag (map, "Not yet specified")? Prisma 8 says no reset, ever, and argues agents misuse one. Graphile Migrate keeps `reset --erase`, Atlas keeps `schema clean`, and our `reset` exists under ADR-0016. The open point is whether anything catch-up cannot move still needs a reset, and whether the CLI should name it in an error.
9. Should a detected coding agent get an extra guard before a data-losing run? Prisma 7.10.1 blocks one without a consent variable. That belongs here or in #771.

### For #770, watch mode

1. What does `generate --watch` watch? Candidates seen: the Current migration and fixtures (Graphile Migrate), the schema root (Prisma `generate`), the contract's resolved inputs through a loader (Prisma 8). For us: the Definition and its imports, `current.sql` for hand edits, and the migrations folder for a branch switch or pull. Does each trigger the same run?
2. Debounce and polling: Graphile Migrate uses 200 ms stability with polling, because plain watchers missed `git stash`. Prisma 8 uses 150 ms. Prisma `generate` has none. What value fits one `generate` run, which builds a Shadow and a Definition database each time (ADR-0011, ADR-0013)? Nobody I read measured it.
3. Overlap: Graphile Migrate coalesces to one trailing rerun. Prisma `generate` queues every event. A rerun with a cancelled in-flight run, or a trailing one, changes how long a typo stays on screen.
4. Failure and recovery output: Graphile Migrate prints the error with its position and keeps the watcher alive, then prints a start and a finish line for the next good run, with no "recovered" line. Prisma `generate` keeps old errors on screen. What does watch print on the first good run after a failure, and does the Dev database stay on its last good state while a run fails?
5. Each save on a live database: with catch-up keeping data, every intermediate Definition state touches the Dev database. A half-typed rename is a drop and an add, which loses the column's data. Graphile Migrate drifts here and recommends against auto-save. Drizzle and Prisma ask first, and a watcher cannot ask. Does watch catch up on every regeneration, or only on a settled one, or hold back any step with an unaccepted Hazard and print it?
6. The first run: Graphile Migrate runs once on `ready` and ignores initial files. Should `generate --watch` start with a full run, including catch-up?
7. How does watch end? Does a failed run set an exit code at Ctrl+C? Prior art keeps the process alive on error and says nothing about the exit code.

### For #771, `--json`

1. One document per command or NDJSON for watch: the map says both. Atlas, Prisma 8, and Drizzle 1.0 print one document per command, and I found no tool that streams events. The event vocabulary, and whether a watch run's document equals a one-shot `generate` document, has no prior art to borrow from.
2. How is a decision the user must make reported? Drizzle: `status: "missing_hints"` and `unresolved[]`, answered by `--hints`. Prisma 8: `CLI.CONSENT_REQUIRED` with `meta.unanswered[]` and the flag that answers each. Prisma 7 and Atlas: a flag (`--accept-data-loss`, `--auto-approve`). We already have `--accept <kind>`. Should JSON list the unaccepted Hazard kinds in this shape?
3. Exit codes: ours are 0, 1, 2 (usage). Drizzle uses 2 for missing hints. Prisma 8 uses 2 could not run, 3 user abort, 4 found something. Atlas lint and migra use 1 and 3. Prisma 8's doc warns that exit code alone misses `warn` diagnostics. How many outcomes need distinct exit codes, and does usage keep 2?
4. What shape does an error take? Prisma 8's envelope has `ok`, `code`, `severity`, `summary`, `why`, `fix`, `nextActions`, `where`, `meta`, `docsUrl`. Drizzle's carries `code`, a human message, and `meta`. Which of these fields earn their place when the reader is a script or an agent?
5. What goes in a success document? Atlas reports applied statements with timing. Prisma 8's `db update` reports `plan.operations[]` with an operation class and the marker hash. Drizzle's `--explain` reports statements and hints. Today's text output names the file written, each Hazard with its statement, and whether the Dev database reset (cli.md, generate). Which of those, plus the catch-up result from #768, does JSON carry?
6. Stdout hygiene: Drizzle's JSON mode skips the progress view and any prompt. Does `--json` imply non-interactive and no color, and where do warnings go (a hand edit's leftover difference, ADR-0013)?
7. Does `--json` reach every command, or only `generate`, `commit`, `verify`, and `reset`? Prisma 8 puts it on every command.

## Sources

[gm-rel]: https://github.com/graphile/migrate/releases
[gm-watch-start]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/watch.ts#L44-L57
[gm-watch-opts]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/watch.ts#L15-L37
[gm-watch-queue]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/watch.ts#L59-L92
[gm-runner-compare]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/currentRunner.ts#L48-L125
[gm-runner-rerun]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/currentRunner.ts#L28-L165
[gm-reverse]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/migration.ts#L662-L672
[gm-after]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/migration.ts#L538-L548
[gm-chain]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/migration.ts#L517-L533
[gm-runstring]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/migration.ts#L562-L604
[gm-migrate]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/migrate.ts#L36-L59
[gm-instr]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/instrumentation.ts#L17-L104
[gm-status]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/status.ts#L70-L77
[gm-reset]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/src/commands/reset.ts#L74-L100
[gm-readme-idem]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L161-L164
[gm-readme-idem2]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L664-L705
[gm-readme-collab]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L651-L662
[gm-readme-drift]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L874-L929
[gm-readme-usage]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L186-L188
[gm-readme-goals]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L56-L57
[gm-readme-root]: https://github.com/graphile/migrate/blob/2cfadbbdb8865ff86db029d04b406a6c808b52b1/README.md#L126-L130
[atlas-dev]: https://atlasgo.io/concepts/dev-database
[atlas-apply]: https://atlasgo.io/declarative/apply
[atlas-lint]: https://atlasgo.io/lint/analyzers
[atlas-versioned]: https://atlasgo.io/versioned/apply
[atlas-diff]: https://atlasgo.io/versioned/diff
[atlas-integrity]: https://atlasgo.io/concepts/migration-directory-integrity
[atlas-cli]: https://atlasgo.io/cli-reference
[atlas-monitor]: https://atlasgo.io/monitoring/overview
[atlas-pending]: https://github.com/ariga/atlas/blob/90dacfc6c25f151fc3d48fdba150c677e9dddf1d/sql/migrate/migrate.go#L715-L790
[prisma-rel]: https://github.com/prisma/prisma/releases
[prisma-shadow]: https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database
[prisma-proto]: https://www.prisma.io/docs/orm/prisma-migrate/workflows/prototyping-your-schema
[prisma-team]: https://www.prisma.io/docs/orm/prisma-migrate/workflows/team-development
[prisma-devdiag]: https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/schema-engine/commands/src/commands/dev_diagnostic.rs#L64-L117
[prisma-push-engine]: https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/schema-engine/commands/src/commands/schema_push.rs#L38-L65
[prisma-dev-reset]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/MigrateDev.ts#L170-L184
[prisma-dev-loss]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/MigrateDev.ts#L207-L258
[prisma-dev-create]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/MigrateDev.ts#L260-L296
[prisma-push-cli]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/DbPush.ts#L187-L255
[prisma-push-reset]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/DbPush.ts#L146-L182
[prisma-ai]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/utils/ai-safety.ts
[prisma-status]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/MigrateStatus.ts#L146-L172
[prisma-diff]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/migrate/src/commands/MigrateDiff.ts#L56
[prisma-gen-watch]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/cli/src/Generate.ts#L286-L345
[prisma-watcher]: https://github.com/prisma/prisma/blob/97ea359250335c1a174504c9b2b7e5fe030ab937/packages/cli/src/generate/Watcher.ts
[prisma-adr287]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/docs/architecture%20docs/adrs/ADR%20287%20-%20Prisma%208%20has%20no%20db%20push%20to%20production.md
[prisma-adr307]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/docs/architecture%20docs/adrs/ADR%20307%20-%20No%20recovery%20resets%20or%20drops%20a%20database.md
[prisma8-migrations]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/skills/prisma-8/references/migrations.md
[prisma8-consent]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/skills/prisma-8/references/migrations.md#workflow--answer-the-data-loss-questions-migration-plan-and-db-update
[prisma8-ref]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/skills/prisma-8/references/migrations.md#dev--ship-transition-the-db-ref-pattern
[prisma8-debug]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/skills/prisma-8/references/debug.md
[prisma8-build]: https://github.com/prisma/prisma/blob/a405bd928ad3bbc10132ed8fb85187e129f8c85c/skills/prisma-8/references/build.md
[drizzle-rel]: https://github.com/drizzle-team/drizzle-orm/releases
[drizzle-push]: https://orm.drizzle.team/docs/drizzle-kit-push
[drizzle-migrations]: https://orm.drizzle.team/docs/migrations
[drizzle-check]: https://orm.drizzle.team/docs/drizzle-kit-check
[drizzle-stable-utils]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-kit/src/cli/commands/pgPushUtils.ts#L136-L171
[drizzle-rc-suggest]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/commands/push-postgres.ts#L188-L326
[drizzle-rc-opts]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/schema.ts#L345-L350
[drizzle-rc-gen]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/schema.ts#L352-L373
[drizzle-rc-push]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/schema.ts#L545-L578
[drizzle-rc-exit]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/schema.ts#L57-L80
[drizzle-hints]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/hints.ts
[drizzle-rc-explain]: https://github.com/drizzle-team/drizzle-orm/blob/5d71fc408add08bd207f4753f4554578ec9e0640/drizzle-kit/src/cli/views.ts#L877-L888
[migra-readme]: https://github.com/djrobstep/migra/blob/345038271b9fd76296c89e01c7256d0d38e2ce83/README.md
[migra-command]: https://github.com/djrobstep/migra/blob/345038271b9fd76296c89e01c7256d0d38e2ce83/migra/command.py
[migra-statements]: https://github.com/djrobstep/migra/blob/345038271b9fd76296c89e01c7256d0d38e2ce83/migra/statements.py
