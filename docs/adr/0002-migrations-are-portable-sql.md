---
status: accepted
---

# Migrations are portable SQL

Every schema migration is a plain SQL file that a pure migration tool such as dbmate can run without this library. The library may generate and apply migrations, but the files are the artifact, so a project can drop the library and keep its migration history. This rules out migrations defined as TypeScript code, as in Knex or Kysely.
