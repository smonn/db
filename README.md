# @smonn/db

A Postgres-first TypeScript toolkit: define your database in TypeScript, migrate it with plain SQL, and query it with code that maps one-to-one onto the SQL it runs.

> **Status:** design phase. Nothing is published yet.

## Principles

- **Postgres first.** Use the database's full feature set rather than a portable subset.
- **SQL you can see.** Every query and migration shows the exact SQL it runs.
- **Migrations are portable SQL.** Plain files that tools like dbmate can run without this library.
- **Small surface, deep modules.** A functional core behind ports and adapters.

## Learn more

- [Glossary](GLOSSARY.md): the project's vocabulary.
- [Architecture decisions](docs/adr/): what was decided and why.

## License

[Apache-2.0](LICENSE)
