# @smonn/db

A Postgres-first TypeScript toolkit: define your database in TypeScript, migrate it with plain SQL, and query it with code that maps one-to-one onto the SQL it runs.

> **Status:** design phase. Nothing is published yet.

## Getting started

This needs Node 24 or later, `pnpm`, and a Postgres 18 server with an empty database to use as your Dev database.

Start a project and install the package, which also gives you the `smonndb` command, with the `postgres` driver:

```sh
pnpm init
pnpm add @smonn/db postgres
```

Describe your database in TypeScript. This file is the Definition:

```ts file=db/definition.ts
import { defineDatabase, defineTable } from "@smonn/db";

export default defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.text().notNull(),
      email: c.text(),
    })),
  },
});
```

Point the CLI at it. `url` is the Dev database:

```ts file=smonndb.config.ts
import { defineConfig } from "@smonn/db/dev";

export default defineConfig({
  definition: "./db/definition.ts",
  migrations: "./db/migrations",
  url: process.env.DATABASE_URL,
});
```

`generate` diffs the Definition against your Committed migrations, writes the result to `db/migrations/current.sql`, and replays it into the Dev database:

```sh
export DATABASE_URL=postgres://localhost/app_dev
smonndb generate
```

```text
wrote db/migrations/current.sql
reset the Dev database
```

`current.sql` is plain SQL you can read and edit. Change the Definition and run `generate` again to regenerate it. If you edit the file yourself, `generate` keeps your edit, replays it, and prints the lines that differ from what it would have written; delete the file to resume generating. When it is right, `commit` freezes it into a numbered Committed migration:

```sh
smonndb commit create-users
```

```text
wrote db/migrations/000001-create-users.sql
```

`migrate` applies the pending Committed migrations to any other database, such as production. It needs no Dev database, only the `url` the config reads:

```sh
DATABASE_URL=postgres://localhost/app_prod smonndb migrate
```

```text
applied 000001-create-users.sql
```

Now query it. The Definition types the rows, with no codegen step:

```ts file=query.ts
import postgres from "postgres";
import { createClient, from, insert } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));

await client.run(insert(db.public.users).values({ id: "u1", email: "a@example.com" }));
const users = await client.all(from(db.public.users).where((u) => u.id.eq("u1")));
console.log(users);

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node query.ts
```

```text
[ { id: 'u1', email: 'a@example.com' } ]
```

### Commands

Run each as `smonndb <command>`, with `--config <path>` to pick a config file other than `smonndb.config.ts`.

| Command           | What it does                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `generate`        | Writes `current.sql` and replays it into the Dev database, resetting that database if behind             |
| `commit <slug>`   | Freezes `current.sql` into the next Committed migration                                                  |
| `reset [--erase]` | Rebuilds the Dev database from the migration files; `--erase` also wipes an unmarked, non-empty database |
| `migrate`         | Applies the pending Committed migrations                                                                 |
| `verify`          | Checks the Committed migrations' hash chain, with no database                                            |

Results go to stdout and errors to stderr, as plain text with no colors. `generate` prints the file it wrote, each Hazard with its statement, and whether it reset the Dev database. Exit codes: 0 on success, 1 on a refusal or failure (a missing folder, a held Dev lock, a bad hash chain), 2 on a usage error.

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

`pnpm check` runs every check CI runs, keeps going after a failure, and exits non-zero if any failed. It needs the test database above. `pnpm check:static` runs all of them but the tests, and needs no database.

`pnpm install` installs the [lefthook](https://lefthook.dev) hooks in `lefthook.yml`. The pre-commit hook runs `oxlint --fix` and `oxfmt` on the staged files and stages their fixes. The pre-push hook runs `pnpm check:static` and the unit tests changed since `origin/main`; the database tests run in CI.

## Learn more

- [Glossary](GLOSSARY.md): the project's vocabulary.
- [Architecture](docs/architecture.md): modules, ports, and import rules.
- [Architecture decisions](docs/adr/): what was decided and why.

## License

[Apache-2.0](LICENSE)
