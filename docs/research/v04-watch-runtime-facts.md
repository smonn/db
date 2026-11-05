# Node and postgres.js facts for generate watch

Research for #767, child of the v0.4 map #765. Feeds the watch grilling ticket #770.

Sources: Node docs (`https://nodejs.org/docs/latest-v24.x/api/` and the `v26.x-staging` branch of `nodejs/node`), Node source (`lib/internal/fs/recursive_watch.js`), postgres.js 3.4.9 and 4.0.0 source from npm and its `CHANGELOG.md`, Postgres 18 docs. Each fact says how it is known:

- **probe** means run in this session. Scripts are in `docs/research/v04-watch-runtime-facts/`. Node: macOS 24.22.1 and 26.13.0 (asdf has 24.21.0, 24.22.1, 26.8.1, 26.12.1, 26.13.0, so Node 24 is installed), Linux through Docker (OrbStack kernel) on `node:24.0.0-slim`, `node:24.21.0-slim`, `node:24-slim` (24.22.2) and `node:26-slim` (26.13.0). Postgres: 18.6 from `node scripts/test-db.ts`, postgres.js 3.4.9 and 4.0.0 installed in a scratch folder only (the repo's dependencies are unchanged).
- **docs** means read in the docs this session, not run.
- **source** means read in the source this session.

## Gist

- Reload a Definition in-process by versioning every project import URL from a synchronous `module.registerHooks` resolve hook. A `?v=` on the entry alone leaves its imports stale. It costs about 13 KB of heap per module per reload, never freed.
- A Worker or child process per run frees everything (32 to 60 ms a run) but a Definition does not cross the boundary: `structuredClone` throws on it.
- `fs.watch(root, { recursive: true })` on Linux misses every save after the first safe-write rename on Node before 24.22.0 (README says "Node 24 or later"). One non-recursive watcher per directory behaved correctly on every version and platform tried.
- postgres.js v4 fixes #623's retype and enum cases and not its domain case, which is worse than v3 for one query shape.
- A session advisory lock stacks, is re-entrant, and lives as long as the one reserved connection. Holding it across runs means one session around the whole loop.

## 1. Loading a changed Definition fresh

ADR-0014 loads the config and the Definition with `import(pathToFileURL(file).href)` (`src/dev/cli/project.ts`, `importDefault`) on Node's built-in type stripping, so files are erasable TypeScript with `.ts` relative imports.

### The cache

- **docs** Node's ESM loader caches by URL and "Modules are loaded multiple times if the `import` specifier used to resolve them has a different query or fragment" (`esm.html#file-urls`). `require.cache` is not used by `import` ("No `require.cache`", same page).
- **docs** No API clears the ESM cache. nodejs/node#52961 was closed by a maintainer: "There's already an ESM cache, and it cannot be exposed. All use cases should be covered by the Hooks API". nodejs/node#38322 settled on the `?v=` workaround.
- **probe** (`cachebust.mjs`, same result on 24.0.0, 24.22.1 and 26.13.0): with `import()` of a plain URL, an edited entry and an edited transitive import are both stale. With `?v=N` on the entry only, the edited entry reloads and the edited transitive import stays stale. A definition split across files (`tables/users.ts`) is exactly the transitive case.

### Versioning every import with a hook

- **docs** `module.registerHooks()` takes synchronous `resolve` and `load` hooks that "run in the same thread and the same realm where the modules are loaded". Added v23.5.0 and v22.15.0. Stability 1.2 (release candidate) since v24.13.1, "Stability: 1.1 - Active Development" before. The returned object has `deregister()`; otherwise hooks "are retained for the lifetime of the running process" (`module.html#moduleregisterhooksoptions`).
- **docs** `module.register()` (the async, off-thread variant) is "Stability: 0 - Deprecated: Use `module.registerHooks()` instead" since v24.15.0. Do not build on it.
- **probe** A `resolve` hook that appends `?v=<generation>` to every resolved `file:` URL outside `/node_modules/`, registered once with a counter bumped per run, reloads the edited entry and the edited leaf. Works with erasable TypeScript, `import type`, and `.ts` extensions on 24.0.0 (with the "Type Stripping is an experimental feature" warning), 24.22.1 and 26.13.0.
- **probe** (`deps.mjs`) The same hook sees every file the graph imports, so it doubles as the dependency list to watch. An `import type` is erased and never resolved, so type-only edits are not dependencies.
- **probe** (`errorcache.mjs`) A syntax error or a throw at evaluation in an import fails that run, and the next run after the fix recovers, with the hook approach. With `?v=` on the entry only, a leaf that loaded once is cached for good, so a later edit of it never shows.
- **source** The hook skips `node_modules`, so the library is not duplicated. A workspace-linked `@smonn/db` resolves outside `node_modules` and would be reloaded each run. The repo already tolerates two copies of the package: `src/runtime/definition/sql-definition.ts` keys the SQL view with `Symbol.for`, and `isEnum` checks `kind`, not identity. Not probed with a linked package.

### Memory

**probe** (`memory.mjs`, `--expose-gc`, a fixture of 20 files of about 3 KB each, hook-versioned, 400 reloads, heap and RSS read after two `gc()` calls):

| reloads | module instances | heapUsed | rss    |
| ------- | ---------------- | -------- | ------ |
| 0       | 0                | 4.0 MB   | 49 MB  |
| 100     | 2000             | 33 MB    | 161 MB |
| 400     | 8000             | 107 MB   | 295 MB |

Node 26.13.0 matched within 1 MB. That is about 0.26 MB of heap and 0.6 MB of RSS per reload of 20 modules, or 13 KB of heap per module instance, and `gc()` frees none of it. A reload takes 4 to 5 ms. Docs are silent on this; the cost is the module records themselves. The cost scales with the Definition's module count and its source size, not with library code. At one save a minute for 8 hours (480 reloads) the 20-file fixture holds about 125 MB. A real Definition's size is not measured.

### A Worker or child process per run

**probe** (`isolation.mjs`, same fixture, 100 runs, `.ts` entry files for both, so type stripping works inside a Worker and a child):

|                                   | per run                          | parent heap after 100 runs | parent RSS after 100 runs |
| --------------------------------- | -------------------------------- | -------------------------- | ------------------------- |
| in-process, hook-versioned        | 4 to 5 ms                        | grows (above)              | grows                     |
| `Worker`                          | 32 ms (26.13.0), 43 ms (24.22.1) | 4.8 MB, flat               | about +55 MB, flat        |
| `child_process` (`execFile` node) | 60 ms                            | 4.9 MB, flat               | flat                      |

Terminating the isolate frees every module. The catch (**probe**, `clone.mjs`): `structuredClone` of a `defineDatabase` result throws `DataCloneError` (the column builders hold closures), with or without a codec. `structuredClone(definitionCatalog(db))` works. So a Worker or child can return the Catalog, not the Definition. `generate` takes a `DefinitionTables` (`GenerateOptions.definition`). How much of `generate` needs the live object beyond the Catalog was not checked.

### Node's own watch mode

- **docs** `node --watch` restarts the process on a change to the entry or any required or imported module (`cli.html#--watch`). Restarting drops every connection and session lock each run. Stability: stable since v22.0.0.
- **docs** `--watch-path` "is only supported on macOS and Windows" (v24 and v26 docs) and turns off watching of imported modules.

### Type stripping

- **docs** Stable since v24.12.0, no warning since v24.3.0, on by default since v23.6.0 (`typescript.html`). Erasable syntax only without `--experimental-transform-types`. File extensions are mandatory in `import`. Node refuses to strip types of files under `node_modules`.
- All three strategies above run erasable `.ts` on both Node majors (**probe**).

## 2. `fs.watch` with `recursive`

### Docs

- **docs** `recursive` on Linux, AIX and IBMi was added in v19.1.0. macOS uses FSEvents for directories, Linux uses inotify (`fs.html#fswatchfilename-options-listener`, Availability).
- **docs** "The `fs.watch` API is not 100% consistent across platforms". It can be "unreliable, and in some cases impossible, on network file systems (NFS, SMB, etc) or host file systems when using virtualization software such as Vagrant or Docker". The `filename` argument "is not always guaranteed to be provided".
- **docs** Inodes: "On Linux and macOS systems, `fs.watch()` resolves the path to an inode and watches the inode. If the watched path is deleted and recreated, it is assigned a new inode. The watch will emit an event for the delete but will continue watching the original inode."
- **docs** An `ignore` option (glob, RegExp, function or array) exists in the v24 and v26 docs without a version in their history. **source** It landed in `d6f7c8d06` (24.x) and `f70020305` (26.x): in v24.14.0 and v26.1.0 or earlier, not in v24.13.0 (`gh api compare`).
- **source** On macOS, recursive watching is native (FSEvents through libuv). Elsewhere it is a JS fallback, `lib/internal/fs/recursive_watch.js`: one `fs.watch` per directory, a `#entries` set of known paths, and `rename` only when a path appears or vanishes by `stat`, otherwise `change`. Before the commit "fs: watch directories, not files, in recursive fs.watch fallback" (`ac4cf5429` on 24.x, `e990324e7` on 26.x), it held one watcher per file. Releases (`gh api compare`): the rewrite is in v24.22.0 and later but not v24.21.0, and in v26.9.0 and later but not v26.8.1. The v24.x-staging and v26.x-staging copies of the file are identical.

### What the events look like

**probe** (`fswatch.mjs`, `sequence.mjs`; a recursive watch of a temp dir; each step waits 300 to 400 ms; counts are events for one operation):

| operation                                                | macOS 24.22.1 and 26.13.0                                       | Linux 24.22.2 and 26.13.0                 | Linux 24.0.0 and 24.21.0                |
| -------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| in-place write (`writeFileSync`)                         | 1, type `rename`                                                | 1, `change`                               | 2, `change`                             |
| safe-write: write `a.ts.tmp`, rename over `a.ts`         | 3 (`rename` tmp, `rename` a, `rename` a)                        | 1 (`change` a, no event for the tmp name) | 3, all `change` a                       |
| in-place write after a safe-write                        | seen                                                            | seen                                      | **never seen again**                    |
| vim style: `a.ts` to `a.ts~`, new `a.ts`, delete `a.ts~` | 3                                                               | 3                                         | **0 events**                            |
| delete and recreate `a.ts`, then write it                | 2, then seen                                                    | 3, then seen                              | **deaf**                                |
| new directory and a file in it at once                   | 2, later edits seen                                             | 2, seen                                   | 2, seen                                 |
| directory tree moved in (git checkout style)             | 1 (the directory only, none for its files)                      | 2                                         | 2                                       |
| 50 files written in a row                                | 50 (51 once on 26.13.0, one duplicate)                          | 100 (`rename` then `change` each)         | 50                                      |
| `ignore: ["**/node_modules/**", "**/*.tmp"]`             | files ignored, the `node_modules` directory event still arrives | same                                      | 24.21.0 same, 24.0.0 ignores the option |

Single-file watch, two safe-writes (`sequence`, `fswatch.mjs`): the first save is seen, the second is not, on macOS and on Linux, as the Inodes caveat says.

Facts the table gives:

- The event type is not a signal. macOS reports `rename` for an ordinary in-place write (FSEvents merges flags); Linux 24.22+ reports `change` for a create after a delete when the two happen together. Treat any event as "look at the path".
- One save yields 1 to 5 events, including editor temp names (`a.ts.tmp`, `a.ts~`). A debounce window collapses them, and the filename is not a safe filter: use the dependency set.
- macOS gives one event for a moved-in tree and none per file inside, so a pull that replaces a directory needs a re-scan.
- Linux Node before 24.22.0 stops seeing a file after the first safe-write rename, and misses a vim-style save entirely. That matches the pre-rewrite per-file design. README says "Node 24 or later" with no minor floor, and 24.21.0 is installed under asdf here.
- **probe** (`sequence.mjs` with `WATCH=dir`) A plain non-recursive `fs.watch(dir)` on the parent directory saw every step of the sequence, including the rename-save and the vim-style save, on macOS 26.13.0 and on Linux 24.0.0 and 24.21.0. Its event types were right on Linux (`rename` for appear and vanish, `change` for a write). A set of per-directory watchers, taken from the hook's dependency list, avoids both the Linux bug and the node_modules tree.

Not measured: event latency, a watch on a bind-mounted host folder from a container (the docs warn), inotify limits (`fs.inotify.max_user_watches`) on a large tree, Windows.

## 3. postgres.js v4 against v3, and #623

### What v4 changes for prepared statements

- **docs** v4.0.0 changelog, New: "Prepared statements are prepared again when a column changes type. A query that the statement's parameter types no longer fit fails before it runs; it is now run once more with a fresh description and the statement prepared again, outside a transaction or reserved connection. On a pool of more than one connection that holds also while other queries are in flight; with `max: 1` only for a query that is alone on the connection, so queries keep their order. v3 kept failing until the connection was replaced." Also: "When one connection sees a statement describe differently, the others prepare it again before their next use". Plus "A statement name the server already has ... is prepared again under a new name instead of failing with `42P05`" and "After `DEALLOCATE ALL`, a statement prepared again is not forgotten". (`https://github.com/porsager/postgres/blob/master/CHANGELOG.md`)
- **source** v3 retries only for the routines `FetchPreparedStatement`, `RevalidateCachedQuery` and `transformAssignedExpr` (`connection.js` lines 26 to 28), as #623's brief says.
- **source** v4 (`src/connection.js`, `failed`, `retryable`, `again`, `described`, `same`) retries a failed prepared statement once, whatever the error code, when the statement was not yet bound, is not cancelled, a cursor or a stream, has the connection's lease, the connection is idle, and either nothing else is in flight or (no lease and `max` is not 1). The retry describes the statement again. If the new parameter OIDs and column type OIDs equal the previous description (`same`), the original error is returned and the cached statement stays.
- **docs** Upstream PR 1257 ("Retry a stale prepared statement only where it is safe", closed as part of v4) states the trade: "a stale statement that has another statement pipelined behind it ... now fails once with the server's error ... instead of being resent, and its next run prepares afresh".

### Does #623 reproduce on v4?

**probe** (`probe623.mjs` with raw `unsafe(text, params, { prepare: true, simple: false })`, and `probe623-driver.mjs`, `probe623-session.mjs`, `probe623-tx.mjs` through the repo's own `postgresJsDriver`, `postgresJsTypes` and `postgresJsConnection`, copied from this commit; PG 18.6; `max` 1 and 4 gave the same results; the pool and one reserved `session` gave the same results):

| DDL, then the same SQL text                                                               | v3.4.9                                              | v4.0.0                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| column `integer` to `text`, `select ... where v = $1`                                     | `22P02` on every retry                              | works                                                                       |
| same, as an `insert ... on conflict`                                                      | `22P02`                                             | works                                                                       |
| enum dropped and recreated, `select` and `insert`                                         | `XX000 cache lookup failed for type` on every retry | works                                                                       |
| table and enum dropped and recreated                                                      | `XX000`                                             | works                                                                       |
| domain dropped and recreated (domain-typed param, `insert`)                               | `XX000`                                             | works                                                                       |
| domain dropped and recreated, `select` of a domain column                                 | works                                               | **`0A000 cached plan must not change result type` on every retry**          |
| `alter table add column`, `select *`                                                      | works                                               | works                                                                       |
| DDL and the stale statement inside one transaction                                        | fails                                               | fails, no retry in a transaction (as the changelog says)                    |
| two stale statements and a fresh one sent together on `max: 1` (`probe623-pipelined.mjs`) | not run                                             | each stale one fails once with the server's error, then the same text works |

So the issue's two examples (retype, enum recreate) no longer reproduce on v4, in a pool or in the one reserved connection a watch would hold. One new case does: after a domain is dropped and recreated, a prepared `select` of a column of that domain fails on every later run, on that connection.

Why (**probe**, `probe-describe.mjs`): the server describes a domain column by its base type. `select v, m from dsc.t` with `v` a domain over `integer` and `m` an enum returned type OID 23 (`int4`) for `v` and the enum's own OID for `m`. The domain's OID never reaches the client, so after a recreation the description is unchanged, v4's `same()` is true, and it hands back the server's error and keeps the statement. The enum's OID changes, which is why the enum case recovers. This is the mechanism by inference from the source and the probe, not from an upstream statement. I did not trace why v3 passes the domain `select`.

Ways out of the domain case (**probe**, `probe623-reset.mjs`, v4, `max: 1`): `deallocate all` on the connection; `await sql.close()` (v4 only, "closes the connections once their queries are done and leaves the pool usable"); `prepare: false` per query. On a pool of more than one connection, `deallocate all` reaches only the connection that runs it. The repo's session reset deliberately keeps statements (`discardAllButStatements` in `src/adapters/postgres-js/driver.ts`), and the domain failure survived it (the `driver.session` rows in `probe623-driver.mjs`).

An upstream search (`gh api search/issues`, repo `porsager/postgres`, "cached plan must not change result type") found #120, #1197, #1234 and #1257, and none about domains. I did not open one.

Not run: the repo's test suite on v4 (that is #697), #364's dead-reserved-connection fix, any browser or Bun runtime.

## 4. A session advisory lock across many runs

### Docs

- **docs** "Once acquired at session level, an advisory lock is held until explicitly released or the session ends." Session-level requests do not honor transactions: "a lock acquired during a transaction that is later rolled back will still be held following the rollback". "A lock can be acquired multiple times by its owning process; for each completed lock request there must be a corresponding unlock request before the lock is actually released." "If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock." (`explicit-locking.html`, 13.3.5)
- **docs** `pg_advisory_unlock_all()` releases every session-level lock and "is implicitly invoked at session end, even if the client disconnects ungracefully". `pg_advisory_unlock` returns false with a warning when the lock is not held. (`functions-admin.html`, advisory lock functions)
- **docs** The pages do not say whether the key space is per database.

### Probes (`probe-lock.mjs`, same on postgres.js 3.4.9 and 4.0.0, key `7666632338`)

- Two `pg_try_advisory_lock` in one session both return true, `pg_locks` shows one row, a second session's try returns false. After one unlock the second session still fails; after the second unlock it gets the lock. A third unlock returns false with a warning.
- `pg_advisory_unlock_all()` releases all stacked levels at once.
- A rolled-back transaction that took the lock leaves it held.
- The key is per database: a session in another database takes the same key while the first holds it.
- `pg_terminate_backend` on the holder releases the lock at once.
- A `reserve()`d connection kept its backend and its lock across 5 s of idling with `idle_timeout: 1` and `max_lifetime: 2`. The defaults are `idle_timeout: null` and `max_lifetime` a random 30 to 60 minutes, `keep_alive: 60` s (**source**, `index.js` in both). On v4, a connection past its `max_lifetime` is marked retiring and closes on `release()` (**source**, `pool.js` `lifetime`): the probe's lock was gone right after `release()` on v4, still held on v3 until `pool.end()`.

### What this means for the repo's locks (reading `src/dev/generate/dev-lock.ts`, `src/runtime/internal/migration-lock.ts`, `src/adapters/postgres-js/driver.ts`)

- `withDevLock` is `driver.session(fn)`: the lock lasts as long as `fn`. The session's end resets the connection with `select pg_advisory_unlock_all()` and then releases it. A lock held across runs is one session around the whole watch loop. `sessionDriver` already hands `fn` a Driver that reuses the locked connection.
- Each `withDevLock(driver)` from the pool would reserve a different connection. If the watcher holds the lock on connection X and a run then calls `withDevLock` on the pool, that call is a second session and its try returns false ("another generate, commit, or reset holds advisory lock"): the watch would lock itself out. (From the stacking probe; I did not run `withDevLock` itself.)
- Inside the held session the lock is re-entrant: a nested `withDevLock` or `acquireMigrationLock` on the same connection returns true and adds a level that only `pg_advisory_unlock_all` clears at session end. The lock cannot refuse a second run in the same process, so the loop has to serialize itself. A separate `generate`, `commit` or `reset` process fails at once on the Dev lock while the watch holds it.
- `acquireMigrationLock` polls `pg_try_advisory_lock` every 100 ms with no timeout. A runtime `migrate` (key `76666326447283`) waits for as long as watch holds that key, with no error. (Code reading; not probed against `migrate`.)
- No reset runs between runs in one held session, so session state (`set`, temp tables, cached statements) persists across runs, and a failed run must roll back its own transaction. `reservedSession.transaction` rolls back on error; other state is untouched.
- If the backend dies mid-watch (a restarted container), the lock is gone and the driver rejects every later statement on that reserved connection (`reservedConnection` in `driver.ts` records `CONNECTION_CLOSED` and the rest). The watch has to notice and take the lock again, which can fail if another process took it meanwhile.
- The Shadow and Definition databases have their own key space, so their locks do not meet the Dev lock.

## 5. Open questions for the watch grilling ticket (#770)

1. **Reload mechanism.** In-process with the hook (4 to 5 ms, about 13 KB per module per reload, grows until the process ends), or a Worker (about 40 ms, nothing grows, only cloneable data returns)? This turns on whether `generate` needs the live Definition or only `definitionCatalog(definition)` and the schema names. Also: recycle the process after N reloads, and what that does to a held lock.
2. **What to watch.** The hook's dependency list (re-collected each run, so a newly added import joins), versus a recursive watch of the project root. Plus `current.sql` and the migrations folder. A macOS directory replace gives no per-file events, so pulls need a re-scan.
3. **Node floor for watch.** Recursive `fs.watch` on Linux is broken on 24.0 to 24.21 and 26.8.1 and earlier. Require 24.22 or later for watch, use per-directory non-recursive watchers (worked everywhere tried), or poll? README promises "Node 24 or later".
4. **Debounce and self-writes.** Window length, and one save gives 1 to 5 events with temp names. Watch writes `current.sql` itself and may write migrations, so it must tell its own writes from an editor's (a content hash is the obvious way; nothing probed).
5. **Locks.** One session around the loop (Dev lock re-entrant, held for hours) or take and release the Dev lock per run? Hold the migrator lock for the whole watch, so a runtime `migrate` waits without a timeout, or only during a run? What happens when the held connection dies, and may `commit` or `reset` run in the same process while watch holds the session?
6. **Does generate hit #623 itself?** Its own queries (introspection, tracking tables) were not checked for stale-type failures. The case that matters is the user's app pool during the dev loop, outside the watcher's control.
7. **postgres.js v4 and the domain case.** After v4, #623's retype and enum cases are fixed, and a recreated domain breaks prepared `select`s of its columns until the connection is recycled. Options: document it (with `sql.close()`, `deallocate all` or `prepare: false` as the reset), file it upstream, or have watch recycle the pool after a run that dropped a domain. #697 should say this in its #623 comment.
8. **Failure behavior.** With hook versioning, a bad import fails one run and the next recovers (probed), so "keep watching, keep the last good Dev database" costs nothing at the loader. The rest of the failed-run policy is open.

## Not verified

- Event latency, containers with a bind-mounted source folder, `inotify` limits, Windows.
- Whether `generate` can run from a Catalog alone.
- A real Definition's module count and memory per reload.
- Which release first honors `ignore` on 26.x: tags 26.1.0 to 26.3.0 contain it, earlier 26.x tags were not compared.
- The mechanism for v3 passing the domain `select` that v4 fails.
- `withDevLock` and `acquireMigrationLock` themselves against two processes. I probed the SQL they issue.
- Linux results come from one kernel (OrbStack's), and Node 24.22.2 stands in for 24.22.x.

## Probe scripts

In `docs/research/v04-watch-runtime-facts/`. Run each with `node file.mjs` (arguments are in its header comment). The Postgres ones read `DATABASE_URL`, and take the path of a postgres.js `src/index.js` installed in a scratch folder. `probe623-driver.mjs`, `probe623-session.mjs` and `probe623-tx.mjs` import `./repo-src/adapters/postgres-js/*.ts` and need a `repo-src/` folder next to them holding a copy of this repo's `src/adapters` and `src/runtime`, beside a scratch `node_modules/postgres`. `clone.mjs` runs from its own folder inside the repo. `attempt.mjs` and `version-imports.mjs` are helpers the others import, so copy them along. Each probe starts with a file-level `oxlint-disable`, so the repo's pre-commit lint passes.
