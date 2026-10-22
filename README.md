# @smonn/db

A Postgres-first TypeScript toolkit: define your database in TypeScript, migrate it with plain SQL, and query it with code that maps one-to-one onto the SQL it runs.

> **Status:** design phase. Nothing is published yet.

## Goals

- **Postgres first.** Use the database's full feature set rather than a portable subset.
- **SQL you can see.** Every query and migration shows the exact SQL it runs.
- **Migrations are portable SQL.** Plain files you can run with `psql` and no library, with a fast generate-edit-commit loop.
- **Types from the Definition.** Query types come straight from the TypeScript Definition, with no codegen step.
- **Small surface, deep modules.** A functional core behind ports and adapters, and a runtime with no dependencies beyond the driver.

## Non-goals

- **Database portability.** Other databases may come later, but never at the cost of Postgres features.
- **Hiding SQL.** No object model that abstracts queries away, as Prisma's does. No active record, identity map, or unit of work.
- **Down migrations.** Undo a change with a new forward migration.
- **Edge and browser runtimes.** Node 24 and later is the target. Others stay possible but untested.

## Development

Tests need a Postgres 18 server. `docker compose up -d --wait` starts one on port 54318, or on `POSTGRES_PORT` when set. Then run `DATABASE_URL=postgres://postgres:postgres@localhost:54318/postgres pnpm test`. Or run `node scripts/test-db.ts`, which starts a server for this checkout on a free port and saves its URL in `.env.test`, so plain `pnpm test` finds it. Each test file gets its own fresh database, dropped afterward.

`pnpm install` sets git's `core.hooksPath` to `.githooks/`, in a fresh clone and in a worktree. The pre-commit hook checks the staged files with `oxfmt --check` and `oxlint`, and the pre-push hook runs `pnpm typecheck` and `pnpm knip`. Neither hook runs the tests. When pre-commit reports formatting, run `pnpm format` and stage the result.

## Learn more

- [Glossary](GLOSSARY.md): the project's vocabulary.
- [Architecture](docs/architecture.md): modules, ports, and import rules.
- [Architecture decisions](docs/adr/): what was decided and why.

## License

[Apache-2.0](LICENSE)
