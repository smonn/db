# @smonn/db

A Postgres-first TypeScript toolkit: define your database in TypeScript, migrate it with plain SQL, and query it with code that maps one-to-one onto the SQL it runs.

> **Status:** design phase. Nothing is published yet.

## Goals

- **Postgres first.** Use the database's full feature set rather than a portable subset.
- **SQL you can see.** Every query and migration shows the exact SQL it runs.
- **Migrations are portable SQL.** Plain files that tools like dbmate can run without this library, with a fast generate-edit-commit loop.
- **Types from the Definition.** Query types come straight from the TypeScript Definition, with no codegen step.
- **Small surface, deep modules.** A functional core behind ports and adapters, and a runtime with no dependencies beyond the driver.

## Non-goals

- **Database portability.** Other databases may come later, but never at the cost of Postgres features.
- **Hiding SQL.** No object model that abstracts queries away, as Prisma's does. No active record, identity map, or unit of work.
- **Down migrations.** Undo a change with a new forward migration.
- **Edge and browser runtimes.** Node 24 and later is the target. Others stay possible but untested.

## Learn more

- [Glossary](GLOSSARY.md): the project's vocabulary.
- [Architecture](docs/architecture.md): modules, ports, and import rules.
- [Architecture decisions](docs/adr/): what was decided and why.

## License

[Apache-2.0](LICENSE)
