---
status: accepted
---

# Migrations are portable SQL

Every schema migration is a plain SQL file that can be read, reviewed, and run with nothing but Postgres. The library may generate and apply migrations, but the files are the artifact, so a project can drop the library and keep its migration history, moving it to a tool such as dbmate by a codemod rather than a rewrite. This rules out migrations defined as TypeScript code, as in Knex or Kysely.
