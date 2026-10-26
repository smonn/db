# Architecture

How the source is laid out for v0.1 and which imports are allowed. The reasons are in [ADR-0006](../adr/0006-zero-dependency-runtime.md) and [ADR-0009](../adr/0009-module-layout-and-ports.md).

- [CLI and migration flow](cli.md): which modules and ports each command touches, and each command's rules.
- [Diff engine](diff-engine.md): how generate turns the Definition into the Current migration.

## Module map

`src/` has three groups, one per future package. Each module is a folder with an `index.ts` holding only its public API. Tests sit next to the file they cover (`driver.ts` and `driver.test.ts`).

The diagrams follow the [C4 model](https://c4model.com/). The container diagram shows how the groups relate to each other and to the outside world. Each component diagram zooms into one group; an arrow leaving the group points at the other group as a whole. Dashed boxes are outside the group being shown. The arrows show the main dependencies, not every one.

### Containers

```mermaid
flowchart TB
  dev_user(["<b>Developer</b><br/>[person]<br/>Writes the Definition and queries, runs the CLI"])
  app["<b>App</b><br/>[Node application]<br/>The user's code"]

  dev["<b>dev/</b><br/>[library + CLI: @smonn/db/dev, bin]<br/>Generates, commits, and applies migrations at dev time"]
  runtime["<b>runtime/</b><br/>[library: @smonn/db, zero dependencies]<br/>Definition, queries, migrator, and port types"]
  adapters["<b>adapters/</b><br/>[library: @smonn/db/postgres-js, @smonn/db/node]<br/>Implement the ports on a real driver and disk"]

  pg[("<b>Postgres</b><br/>[database server]<br/>dev, Shadow, and production Databases")]
  fs[("<b>Filesystem</b><br/>[disk]<br/>Definition files and Migrations")]

  dev_user -- "runs generate, commit, migrate" --> dev
  dev_user -- "writes" --> app
  app -- "defines tables, builds queries, runs migrator" --> runtime
  app -- "passes a Driver and MigrationSource" --> adapters
  dev -- "uses Definition, migrator, port types" --> runtime
  dev -- "CLI wires in" --> adapters
  adapters -- "implements ports from" --> runtime
  adapters -- "SQL via postgres.js" --> pg
  adapters -- "reads and writes" --> fs

  classDef external stroke-dasharray: 5 5
  class dev_user,app,pg,fs external
```

### runtime/ components

```mermaid
flowchart TB
  subgraph runtime["runtime/ · @smonn/db"]
    definition["<b>definition</b><br/>[module]<br/>Declares tables and columns; infers row types"]
    query["<b>query</b><br/>[module]<br/>from, where, select, insert, one call per SQL clause; sql for whole hand-written statements"]
    sql["<b>sql</b><br/>[module]<br/>SQL fragments, the sql template, rendering to text and params"]
    migrator["<b>migrator</b><br/>[module]<br/>Verifies the hash chain and applies Committed migrations under an advisory lock"]
    ports["<b>ports</b><br/>[types only]<br/>Driver, Connect, MigrationSource, FileSystem"]
    internal["<b>internal</b><br/>[module, never exported]<br/>Shared helpers: sha256 and the migration file format"]
  end

  adapters["<b>adapters/</b><br/>[container]"]

  query -- "reads column types" --> definition
  query -- "renders with" --> sql
  migrator -- "reads migrations and runs SQL through" --> ports
  migrator -- "parses and hashes migration files with" --> internal
  adapters -- "implement" --> ports

  classDef external stroke-dasharray: 5 5
  class adapters external
```

### adapters/ components

```mermaid
flowchart TB
  subgraph adapters["adapters/"]
    pgjs["<b>postgres-js</b><br/>[adapter: @smonn/db/postgres-js]<br/>Driver and Connect on postgres.js; pg comes later"]
    node["<b>node</b><br/>[adapter: @smonn/db/node]<br/>MigrationSource and FileSystem on node:fs"]
  end

  runtime["<b>runtime/</b><br/>[container]"]
  pg[("<b>Postgres</b>")]
  fs[("<b>Filesystem</b>")]

  pgjs -- "implements Driver from" --> runtime
  node -- "implements MigrationSource, FileSystem from" --> runtime
  pgjs -- "SQL" --> pg
  node -- "reads and writes" --> fs

  classDef external stroke-dasharray: 5 5
  class runtime,pg,fs external
```

### dev/ components

```mermaid
flowchart TB
  subgraph dev["dev/ · @smonn/db/dev"]
    cli["<b>cli</b><br/>[Node composition root, bin]<br/>Parses commands, loads config and Definition, wires adapters"]
    config["<b>config</b><br/>[module]<br/>defineConfig, and checks a loaded config"]
    generate["<b>generate</b><br/>[module]<br/>Builds, writes, and applies the Current migration; commits it; resets the Dev database"]
    shadow["<b>shadow</b><br/>[module]<br/>Creates, sweeps, and drops the Shadow and Definition databases"]
    introspect["<b>introspect</b><br/>[module]<br/>Reads a catalog from a live Database"]
    diff["<b>diff</b><br/>[module]<br/>Compares two catalogs and emits Migration SQL"]
    catalog["<b>catalog</b><br/>[module]<br/>The flat fact map both introspections produce"]
  end

  runtime["<b>runtime/</b><br/>[container]"]
  adapters["<b>adapters/</b><br/>[container]"]

  cli -- "checks the config with" --> config
  cli -- "runs" --> generate
  generate -- "builds Shadow and Definition databases with" --> shadow
  generate -- "reads both databases with" --> introspect
  generate -- "compares with" --> diff
  introspect -- "produces" --> catalog
  diff -- "compares" --> catalog
  cli -- "runs migrator, reads Definition from" --> runtime
  generate -- "uses ports from" --> runtime
  cli -- "wires in" --> adapters

  classDef external stroke-dasharray: 5 5
  class runtime,adapters external
```

### Ports

| Port            | Used by                                                                           | v0.1 adapter                                        |
| --------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| Driver          | migrator, introspect, shadow, generate, and running statements built with `query` | `postgres-js` (wraps postgres.js; `pg` comes later) |
| Connect         | shadow, to open the Shadow and Definition databases on the Dev database's server  | `postgres-js`                                       |
| MigrationSource | migrator (read-only, so migrations can be bundled or in memory)                   | `node`                                              |
| FileSystem      | generate, commit, and rebase (read, write, list, mkdir, remove, rename)           | `node`                                              |

All port types live in `runtime/ports` as type-only exports, so adapters depend on `runtime/` alone. Logger, Clock, and randomness will become ports after v0.1. A Codec is not a port: the query layer applies it, and no adapter supplies one (ADR-0022). Hashing uses a small `sha256` helper over the Web Crypto global rather than a port; ADR-0009 says why. It lives in `runtime/internal`, which holds shared helpers that are never public API.

## Import rules

The layer map is design intent: when code breaks it, fix the code, and change the map only with the design.

| Layer       | Paths                    | May import                                         | Bans                                         |
| ----------- | ------------------------ | -------------------------------------------------- | -------------------------------------------- |
| runtime     | `src/runtime/`           | only itself, no npm packages                       | `node:*`; `process`, `Buffer`, `__dirname`   |
| adapters    | `src/adapters/<name>/`   | `runtime/ports`, `runtime/internal`, its own files | npm packages but its host (`postgres`)       |
| dev         | `src/dev/` but `dev/cli` | `runtime/`, other `dev/` modules                   | `adapters/`; `node:*`; Node globals as above |
| composition | `src/dev/cli/`           | everything above                                   | nothing                                      |

Each folder under a group is a module: its `index.ts` is its only entry point, and any other module imports it through that file. To add a module, create the folder with an `index.ts` of named re-exports, then run `pnpm check`. The rules match folders by pattern, so a new module needs no config change.

CI enforces the module boundaries:

- `scripts/check-imports.ts` holds the dependency-cruiser rules, each with a one-line comment: `runtime/` stays self-contained and free of npm packages, an adapter imports only `runtime/ports`, `runtime/internal`, and its host package, only `dev/cli` wires in adapters, `node:*` stays in host code, cross-module imports go through `index.ts`, no `src/` file imports a group index such as `src/runtime/index.ts`, no other module's `index.ts` re-exports `runtime/internal`, no cycles, and only tests import `*.test.ts` files, `*.test-helper.ts` helpers, and `vitest`. Tests in any group may import `adapters/postgres-js/test-database.test-helper.ts`, which the group, adapter, and `index.ts` rules otherwise forbid. It fails when it scans 0 modules.
- `.oxlintrc.json` bans the `process`, `Buffer`, and `__dirname` globals in `src/` outside `adapters/` and `dev/cli`.
- `scripts/check-index-exports.ts` keeps each `index.ts` to named re-exports: no declarations, no `export *`. It also checks that `src/runtime/index.ts` and `src/dev/index.ts` exist and re-export only names their group's module indexes export, a value as a value and a type as a type, never from `runtime/internal` or `dev/cli`.

oxfmt formats TypeScript and Markdown. knip reports unused files, exports, and dependencies.

### Checks and baselines

`pnpm check` runs every gate and the tests; `pnpm check:static` runs every gate but the tests. Each gate is also its own script: `format:check`, `check:docs`, `check:mermaid`, `typecheck`, `lint`, `lint:actions`, `check:imports`, `check:index`, `knip`, `deps` (rev-dep duplicated-code detection), `fta` (file maintainability), and `coverage`.

Baselines recorded at adoption (2026-10-22), each lowered as code improves and never raised without the maintainer:

- `complexity` sits above its target of 6. The comment beside it in `.oxlintrc.json` names the current cap and the worst function. `max-params` and `max-depth` are at their target of 4.
- Every TypeScript strictness flag is on, so the compiler has no baseline.

## Package entry points

| Entry                   | Source                              | Contents                                              |
| ----------------------- | ----------------------------------- | ----------------------------------------------------- |
| `@smonn/db`             | `src/runtime/index.ts`              | runtime: sql, definition, query, migrator, port types |
| `@smonn/db/postgres-js` | `src/adapters/postgres-js/index.ts` | Driver adapter                                        |
| `@smonn/db/node`        | `src/adapters/node/index.ts`        | Node MigrationSource and FileSystem adapters          |
| `@smonn/db/dev`         | `src/dev/index.ts`                  | config, catalog, introspect, diff, shadow, generate   |
| `smonndb` bin           | `src/dev/cli/bin.ts`                | the CLI, shipped as the package's `bin`               |

Each subpath maps to one future package, so a split renames imports one-to-one. `src/runtime/index.ts` and `src/dev/index.ts` list the package's public API by hand, picked from their group's module indexes, and no `src/` file imports them. A module index also serves imports between modules, so a name there is not public until a group index lists it.

tsdown builds every entry in one pass (`pnpm build`, which `prepack` runs before `pnpm pack`), so modules shared between entries land in shared chunks and load once. It also writes the `exports` and `bin` fields of `package.json` from `tsdown.config.ts`: add an entry there, build, and commit the rewritten `package.json`. `src/dev/cli/package.test.ts` packs the tarball, installs it in a temp project, imports and type-checks each entry, runs the bin, and fails when the build changed `package.json`.
