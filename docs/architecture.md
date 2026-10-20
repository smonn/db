# Architecture

How the source is laid out for v0.1 and which imports are allowed. The reasons are in [ADR-0006](adr/0006-zero-dependency-runtime.md) and [ADR-0009](adr/0009-module-layout-and-ports.md).

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
    query["<b>query</b><br/>[module]<br/>from, where, select, insert, one call per SQL clause"]
    sql["<b>sql</b><br/>[module]<br/>SQL fragments, the sql template, rendering to text and params"]
    migrator["<b>migrator</b><br/>[module]<br/>Verifies the hash chain and applies Committed migrations under an advisory lock"]
    ports["<b>ports</b><br/>[types only]<br/>Driver, MigrationSource, FileSystem"]
  end

  adapters["<b>adapters/</b><br/>[container]"]

  query -- "reads column types" --> definition
  query -- "renders with" --> sql
  migrator -- "reads migrations and runs SQL through" --> ports
  adapters -- "implement" --> ports

  classDef external stroke-dasharray: 5 5
  class adapters external
```

### adapters/ components

```mermaid
flowchart TB
  subgraph adapters["adapters/"]
    pgjs["<b>postgres-js</b><br/>[adapter: @smonn/db/postgres-js]<br/>Driver on postgres.js; pg comes later"]
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
    generate["<b>generate</b><br/>[module]<br/>Builds, writes, and applies the Current migration; commits it"]
    shadow["<b>shadow</b><br/>[module]<br/>Builds the Shadow database from Committed migrations"]
    introspect["<b>introspect</b><br/>[module]<br/>Reads a catalog from a live Database"]
    diff["<b>diff</b><br/>[module]<br/>Compares two catalogs and emits Migration SQL"]
    catalog["<b>catalog</b><br/>[module]<br/>The shared model both sides of the diff convert into"]
  end

  runtime["<b>runtime/</b><br/>[container]"]
  adapters["<b>adapters/</b><br/>[container]"]

  cli -- "runs" --> generate
  generate -- "builds Shadow database with" --> shadow
  generate -- "reads Shadow database with" --> introspect
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
| MigrationSource | migrator (read-only, so migrations can be bundled or in memory)                   | `node`                                              |
| FileSystem      | generate and commit (read, write, list, mkdir)                                    | `node`                                              |

All port types live in `runtime/ports` as type-only exports, so adapters depend on `runtime/` alone. Logger, Codec, Clock, and randomness will become ports after v0.1. Hashing uses a small `sha256` helper over the Web Crypto global rather than a port; ADR-0009 says why.

## Migration flow

Which modules and ports each command touches. The steps restate ADR-0003, ADR-0007, and ADR-0008; how the Shadow database is managed, how the diff works, and how the migrator tracks what ran are open questions on the [v0.1 map](https://github.com/smonn/db/issues/3).

```mermaid
sequenceDiagram
  participant CLI as dev/cli
  participant Gen as dev/generate
  participant Shadow as dev/shadow
  participant Diff as dev/diff
  participant FS as FileSystem port
  participant DB as Driver port
  participant Mig as runtime/migrator

  Note over CLI,Mig: generate (ADR-0003)
  CLI->>Gen: Definition, config
  Gen->>FS: read Committed migrations
  Gen->>Shadow: build Shadow database from them
  Shadow->>DB: run Committed migrations
  Gen->>DB: introspect Shadow database
  Gen->>Diff: Definition vs Shadow database
  Diff-->>Gen: Current migration SQL
  Gen->>FS: write Current migration
  Gen->>DB: apply Current migration to dev Database

  Note over CLI,Mig: commit (ADR-0003, ADR-0008)
  CLI->>Gen: commit
  Gen->>FS: write next Committed migration with hash-chain header

  Note over CLI,Mig: migrate (ADR-0007)
  CLI->>Mig: MigrationSource, Driver
  Mig->>DB: take advisory lock, read which Committed migrations ran
  Mig->>Mig: verify hash chain, plan the rest
  Mig->>DB: run each remaining Committed migration
```

## Import rules

Once tooling lands, dependency-cruiser will enforce these as CI errors, and its config will replace this list. They are a starting point and may change.

1. `runtime/` imports nothing outside `runtime/`.
2. `runtime/` imports no npm packages.
3. `adapters/<x>` imports only `runtime/ports` plus its own host package (`postgres`, `node:*`).
4. Adapters never import other adapters or `dev/`.
5. `dev/` may import `runtime/` but never `adapters/`, except `dev/cli`, the Node composition root.
6. `node:*` imports appear only in `adapters/` and `dev/cli`.
7. Cross-module imports go through the module's `index.ts`.
8. No cycles.
9. Non-test code never imports `*.test.ts` files or test helpers.

Oxlint will cover what dependency-cruiser can't:

- `eslint/no-restricted-globals` bans `process`, `Buffer`, and `__dirname` outside `adapters/` and `dev/cli`. That exemption needs per-path overrides, which are not yet verified in Oxlint.
- `index.ts` holds only named re-exports: no declarations, no `export *`. If no Oxlint rule can express this, a check under `scripts/` does.

oxfmt formats TypeScript and Markdown. knip reports unused files, exports, and dependencies.

## Package entry points

| Entry                   | Contents                                              |
| ----------------------- | ----------------------------------------------------- |
| `@smonn/db`             | runtime: sql, definition, query, migrator, port types |
| `@smonn/db/postgres-js` | Driver adapter                                        |
| `@smonn/db/node`        | Node MigrationSource and FileSystem adapters          |
| `@smonn/db/dev`         | catalog, introspect, diff, shadow, generate           |
| CLI binary              | `dev/cli`, shipped as the package's `bin`             |

Each subpath maps to one future package, so a split renames imports one-to-one.
