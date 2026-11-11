# @smonn/db

A Postgres-first TypeScript toolkit: define your database in TypeScript, migrate it with plain SQL, and query it with code that maps one-to-one onto the SQL it runs.

> **Status:** design phase. The package is published on npm.

## Getting started

`@smonn/db` is on npm, so the `pnpm add` below installs it. To try unreleased code, run `pnpm pack` in a checkout, which writes `smonn-db-<version>.tgz`, and install that with `pnpm add ./smonn-db-<version>.tgz postgres`.

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
      id: c.text().primaryKey(),
      email: c.text(),
    })),
    posts: defineTable((c) => ({
      id: c.text().notNull(),
      authorId: c.text().notNull(),
      title: c.text().notNull(),
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

`values` takes one row. `valuesMany` takes an array of rows, and its `returning` makes a query that `client.one` refuses. A wrong or missing key in either is a type error that names it.

### Selecting columns

`pick` selects the columns you name, each under its own key, in the order you name them; a repeated name selects once. `select` takes a callback for the cases `pick` can't express, such as renaming a column. Either replaces an earlier one, and `where`, `orderBy`, `limit`, and `offset` can come before or after it. A name that is no column is a type error that lists the table's columns.

```ts file=select.ts
import postgres from "postgres";
import { createClient, from } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));

console.log(await client.all(from(db.public.users).pick("email", "id")));
console.log(await client.all(from(db.public.users).select((u) => ({ mail: u.email }))));

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node select.ts
```

```text
[ { email: 'a@example.com', id: 'u1' } ]
[ { mail: 'a@example.com' } ]
```

### Ordering and paging

`orderBy`, `limit`, and `offset` add the clauses of the same names. `orderBy` takes the columns `where` gets and returns one ordering or an array of them: `u.email.asc()`, `u.email.desc()`, or a bare column, which sorts ascending. A repeated call appends, so the first call's orderings sort first. On a nullable column, `asc` and `desc` take `{ nulls: "first" | "last" }`; without it Postgres's default holds. On a NOT NULL column, `nulls` is a type error.

```ts file=paging.ts
import postgres from "postgres";
import { createClient, from, insert } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));

await client.run(insert(db.public.users).values({ id: "u2" }));
await client.run(insert(db.public.users).values({ id: "u3", email: "c@example.com" }));
const page = await client.all(
  from(db.public.users)
    .orderBy((u) => [u.email.desc({ nulls: "last" }), u.id])
    .limit(2)
    .offset(1),
);
console.log(page);

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node paging.ts
```

```text
[ { id: 'u1', email: 'a@example.com' }, { id: 'u2', email: null } ]
```

`limit(n)` and `offset(n)` bind `n` as a param and throw unless it is a non-negative safe integer. Neither needs an `orderBy`, though without one Postgres promises no row order. A later call replaces an earlier one. `client.one` ignores `limit(1)`: it counts the rows that come back and throws unless there is exactly one.

### Matching sets and patterns

`in(list)` and `notIn(list)` compare a column with a list of values. `like(pattern)` and `ilike(pattern)` match text, and `ilike` ignores case. An array column takes `includes(value)`, which asks whether the array holds that value.

```ts file=matching.ts
import postgres from "postgres";
import { createClient, from } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));

const ids = from(db.public.users)
  .pick("id")
  .orderBy((u) => u.id);
console.log(await client.all(ids.where((u) => u.id.in(["u1", "u3", "nope"]))));
console.log(await client.all(ids.where((u) => u.id.notIn(["u1"]))));
console.log(await client.all(ids.where((u) => u.email.ilike("C%"))));

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node matching.ts
```

```text
[ { id: 'u1' }, { id: 'u3' } ]
[ { id: 'u2' }, { id: 'u3' } ]
[ { id: 'u3' } ]
```

`in` renders `= any($1)` and `notIn` renders `<> all($1)`. The list binds as one array param, so the statement stays the same whatever the list's length. `in([])` matches no row and `notIn([])` matches every row. Elements are the column's non-null type and go through its codec. A NULL column matches neither call, except `notIn([])`, which matches every row. `like` and `ilike` take the pattern as written, so `%` and `_` are wildcards. `includes(value)` renders `$1 = any(column)` and takes one element, such as `e.lately.includes("good")` on the `lately` column above.

Each call exists only where Postgres accepts it. `like` and `ilike` are offered on `text` and `varchar` columns and domains over them, and on no other type. `in` and `notIn` are offered on every column except arrays. `includes` is offered on arrays alone. Calling one elsewhere is a type error that names the call and the column's type, such as `Property 'like' does not exist on type 'ColumnRef<number, "number">'`. There is no `between`, `notLike`, `@>`, or `&&`; write `gte` and `lte`, `not(...)`, or a `sql.expr` fragment instead.

### SQL fragments

`` sql.expr<V>`...` `` writes one expression the builder lacks, such as a function call, for `where`, `select`, `returning`, `orderBy`, `values`, `valuesMany`, and `set`. A column ref in the template renders as its column, and any other value binds as a param. `V` is the expression's type, and defaults to `unknown` where nothing names it. A fragment renders in parentheses as one term in `select`, `returning`, `values`, `valuesMany`, `set`, `doUpdate`, a join's `on`, and before `asc()` or `desc()`, so a comma or an operator in it can't change the statement around it; a ref or a comparison gains none. A fragment in `where` is the whole predicate, and a bare one in `orderBy` is the whole sort key, which may name its own direction, so both stay bare.

```ts file=fragments.ts
import postgres from "postgres";
import { createClient, from, sql } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const pg = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(pg));

const query = from(db.public.users)
  .where((u) => sql.expr`upper(${u.email}) like ${"C%"}`)
  .select((u) => ({ id: u.id, domain: sql.expr<string>`split_part(${u.email}, '@', 2)` }));
console.log(await client.all(query));

await pg.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node fragments.ts
```

```text
[ { id: 'u3', domain: 'example.com' } ]
```

`where`, `and`, `or`, and `not` take an `Expr<boolean | null>`, which a fragment in `where` becomes without a type argument. A comparison such as `u.id.eq("u1")` is an `Expr<boolean>`, so it also selects as a boolean or sorts in `orderBy`. A fragment in `orderBy` sorts ascending, or takes `asc()` and `desc()`, with `nulls` only when `V` includes `null`. A fragment holding a comma sorts as one row, which is never NULL, so `nulls` doesn't place the NULLs inside it. A fragment runs no codec: its params bind as given and its value comes back as the driver reads it. A nested fragment or comparison inlines in parentheses, and a statement inside a fragment throws, so it can't hold a subquery.

### Joining tables

`innerJoin(table, on)` and `leftJoin(table, on)` add a table, and `on` is required. Each callback, in `on`, `where`, `select`, and `orderBy`, gets one parameter per table in join order, so a table joined to itself needs no alias: `from(users).innerJoin(users, (a, b) => ...)`.

```ts file=joins.ts
import postgres from "postgres";
import { createClient, from, insert } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));
const { users, posts } = db.public;

await client.run(
  insert(posts).valuesMany([
    { id: "p1", authorId: "u1", title: "Hello" },
    { id: "p2", authorId: "u1", title: "Again" },
  ]),
);
const titles = from(users)
  .innerJoin(posts, (u, p) => p.authorId.eq(u.id))
  .orderBy((_u, p) => p.title)
  .select((u, p) => ({ email: u.email, title: p.title }));
console.log(await client.all(titles));
const silent = from(users)
  .leftJoin(posts, (u, p) => p.authorId.eq(u.id))
  .where((_u, p) => p.id.isNull())
  .orderBy((u) => u.id)
  .select((u, p) => ({ id: u.id, title: p.title }));
console.log(await client.all(silent));

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node joins.ts
```

```text
[
  { email: 'a@example.com', title: 'Again' },
  { email: 'a@example.com', title: 'Hello' }
]
[ { id: 'u2', title: null }, { id: 'u3', title: null } ]
```

A joined builder is no query until `select` names its columns, since two tables can share a name such as `id`, so `client.all` refuses it, and a JavaScript caller that runs it gets an error that says so. `pick` isn't offered after a join. Joins come before `select`, whose result takes no more of them; `where`, `orderBy`, `limit`, and `offset` can come before or after it.

After `leftJoin`, that table's columns read `V | null` in later callbacks and in the rows, since a row with no match there reads NULL, and they gain `isNull()`. Its `on` sees them as declared. A NULL runs no codec; each other value goes through its own table's codec.

A comparison takes a value or another column, as `p.authorId.eq(u.id)` does. A column operand runs no codec, and it must share the column's SQL type class, nullable or not: Postgres compares `integer` with `bigint` but not `uuid` with `text`, so comparing those two is a type error. An enum, a domain over one, or an array compares only with the identical type, so building such a comparison throws, naming both columns.

The SQL qualifies every column by its table's alias, the table's SQL name, so `titles` renders `select "users"."email", "posts"."title" from "public"."users" inner join "public"."posts" on "posts"."authorId" = "users"."id" order by "posts"."title"`. A repeated table takes `_2`, `_3`, and so on, skipping names in use and cut so the alias fits Postgres's 63 bytes. A column ref in `sql.expr` renders qualified too, and a query with no join keeps its bare column names, apart from the refs in an `orderBy` term, which stay qualified so an output alias of the same name can't capture them. Right, full, and cross joins aren't offered; write them with `sql`.

### Updating rows

`update(table).set({...})` takes `where(...)` or `allRows()` and nothing else, as `deleteFrom` does. It is not a statement until you call one, so `client.run(update(db.public.users).set({ email: null }))` is a type error that names both calls, and a JavaScript caller that runs it gets an error that says the same. A forgotten `where` can't rewrite a table. Repeated `where` calls combine with `and`, and the predicates are the ones `from` takes.

```ts file=update.ts
import postgres from "postgres";
import { createClient, sql, update } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const pg = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(pg));
const { users } = db.public;

console.log(
  await client.run(
    update(users)
      .set({ email: "a@example.org" })
      .where((u) => u.id.eq("u1")),
  ),
);
console.log(
  await client.one(
    update(users)
      .set({ email: (u) => sql.expr<string | null>`upper(${u.email})` })
      .where((u) => u.id.eq("u3"))
      .returning((u) => ({ id: u.id, email: u.email })),
  ),
);

await pg.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node update.ts
```

```text
{ count: 1 }
{ id: 'u3', email: 'C@EXAMPLE.COM' }
```

`set` takes the columns to change, each optional, with `null` only on a nullable column. A value is the column's type, a `sql.expr` fragment of that type, or a callback that gets the columns and returns one, so ``n: (u) => sql.expr<number>`${u.n} + 1` `` adds one. Each key takes one callback. A fragment runs no codec; any other value goes through the column's codec when the statement renders. A value that is `undefined` is skipped, and a `set` left with no column throws `update needs at least one column to set`.

An `identity("always")` column can't be set: Postgres refuses a written value for it. Its type lists the column under the key `"id is generated always, so update can't set it"`, so `set({ id: 5 })` prints that reason. The key compiles, and throws at run time as an unknown column.

Without `returning`, only `client.run` takes the statement, and it reports how many rows changed. `returning` takes the same column picks as `insert`, reads the updated rows, so it holds the new values, and makes a query for `client.all` and `client.one`. `client.one` on a primary-key `where` is the not-found check: it throws when no row matched. `allRows()` can change several rows, so `client.one` refuses what its `returning` makes. `UPDATE ... FROM` is not covered; write it with `sql`.

### Deleting rows

`deleteFrom(table)` takes `where(...)` or `allRows()` and nothing else. It is not a statement until you call one, so `client.run(deleteFrom(db.public.users))` is a type error that names both calls, and a JavaScript caller that runs it gets an error that says the same. A forgotten `where` can't empty a table. Repeated `where` calls combine with `and`, and the predicates are the ones `from` takes.

```ts file=delete.ts
import postgres from "postgres";
import { createClient, deleteFrom, from } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const sql = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(sql));
const { users } = db.public;

console.log(await client.run(deleteFrom(users).where((u) => u.email.isNull())));
console.log(
  await client.one(
    deleteFrom(users)
      .where((u) => u.id.eq("u3"))
      .returning((u) => ({ id: u.id })),
  ),
);
console.log(await client.run(deleteFrom(users).allRows()));
console.log(await client.all(from(users)));

await sql.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node delete.ts
```

```text
{ count: 1 }
{ id: 'u3' }
{ count: 1 }
[]
```

Without `returning`, only `client.run` takes the statement, and it reports how many rows went. `returning` takes the same column picks as `insert`, reads the deleted rows, and makes a query for `client.all` and `client.one`. `client.one` on a primary-key `where` is the not-found check: it throws when no row matched. `allRows()` can delete several rows, so `client.one` refuses what its `returning` makes. `DELETE ... USING` is not covered; write it with `sql`.

### Upserting rows

`onConflict((u) => [...])` on an insert names the columns of a key the Definition declares: the primary key, a `unique()` column, a `unique` entry, or a unique index on plain columns, in any order. A list that matches no key is a type error, such as `(email) is not a key of the table`, and a JavaScript caller gets the same error when the statement is built. A key that only a partial unique index backs takes that index's `where`, so Postgres infers it; two partial indexes on the same columns are a type error. A constraint name or an expression target needs `sql`.

```ts file=upsert.ts
import postgres from "postgres";
import { createClient, insert } from "@smonn/db";
import { postgresJsConnection, postgresJsDriver, postgresJsTypes } from "@smonn/db/postgres-js";
import db from "./db/definition.ts";

const pg = postgres(process.env.DATABASE_URL ?? "", {
  types: postgresJsTypes,
  connection: postgresJsConnection,
});
const client = createClient(postgresJsDriver(pg));
const { users } = db.public;
const upsert = (email: string) =>
  insert(users)
    .values({ id: "u1", email })
    .onConflict((u) => [u.id]);

console.log(
  await client.all(
    upsert("a@example.com")
      .doNothing()
      .returning((u) => ({ id: u.id })),
  ),
);
console.log(
  await client.all(
    upsert("b@example.com")
      .doNothing()
      .returning((u) => ({ id: u.id })),
  ),
);
console.log(
  await client.one(
    upsert("c@example.com")
      .doUpdate((_, excluded) => ({ email: excluded.email }))
      .returning((u) => ({ id: u.id, email: u.email })),
  ),
);
console.log(
  await client.all(
    upsert("d@example.com")
      .doUpdate((_, excluded) => ({ email: excluded.email }))
      .where((existing) => existing.email.isNull())
      .returning((u) => ({ email: u.email })),
  ),
);

await pg.end();
```

```sh
DATABASE_URL=postgres://localhost/app_prod node upsert.ts
```

```text
[ { id: 'u1' } ]
[]
{ id: 'u1', email: 'c@example.com' }
[]
```

`onConflict` takes `doNothing()` or `doUpdate(...)` and nothing else; neither alone is a statement. `doUpdate((existing, excluded) => ({...}))` follows `set`'s rules: each column optional, `undefined` skipped, an empty object refused, and no `identity("always")` column. A value is the column's type, a column of the same type such as `excluded.email`, or a `sql.expr` fragment that may name both rows, such as ``n: sql.expr<number>`${existing.n} + ${excluded.n}` ``. `.where((existing, excluded) => ...)` updates only the rows it holds for, and repeated calls combine with `and`. An enum column takes no column of another enum, in either place: Postgres has no cast between two enums.

`returning` reads the rows inserted or updated, so a skipped row returns nothing. `client.one` refuses what `doNothing()` and a `doUpdate` with `where` make, since either may return no row (`on conflict may skip the row; run it with client.all`); a bare `doUpdate` of one row returns it. Postgres finds no conflict on a NULL in a nullable key, unless the key is `nullsNotDistinct`, so that row inserts. A key repeated within one `valuesMany` fails under `doUpdate`, and `doNothing` keeps the first of those rows.

### Commands

Run each as `smonndb <command>`, with `--config <path>` to pick a config file other than `smonndb.config.ts`.

| Command                 | What it does                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `generate`              | Writes `current.sql` and catches the Dev database up, replaying new files or else diffing it             |
| `commit <slug>`         | Freezes `current.sql` into the next Committed migration                                                  |
| `reset [--erase]`       | Rebuilds the Dev database from the migration files; `--erase` also wipes an unmarked, non-empty database |
| `migrate`               | Applies the pending Committed migrations                                                                 |
| `verify`                | Checks the Committed migrations' hash chain, with no database                                            |
| `rebase [--onto <ref>]` | Moves the Committed migrations `<ref>` lacks onto its tip, with no database                              |

Results go to stdout and errors to stderr, as plain text with no colors. `generate` prints the file it wrote, each Hazard with its statement, each rename hint, and a line when it replayed files into, diffed, or reset the Dev database. While a runtime `migrate` holds the migrator's lock, `generate`, `commit`, and `reset` print `waiting for the migrator's lock` to stderr and keep waiting. Exit codes: 0 on success, 1 on a refusal or failure (a missing folder, a held Dev lock, a bad hash chain), 2 on a usage error.

### Changing types under a live pool

The driver prepares each query and caches the statement per connection by its SQL text. After DDL retypes a column, or drops and recreates an enum or domain, a pool that was open before the change reuses the stale statement, and the same query fails, with `invalid input syntax for type integer` or `cache lookup failed for type`. Recreate the pool after `generate` or `migrate` changes such a type. A long-running dev server needs a restart, or a new pool, to see the change.

### Enums and domains

`defineEnum` and `defineDomain` declare a Postgres type. Each sits in a schema's object beside the tables and takes its SQL name from its key. A column uses it through `c.enum(...)` or `c.domain(...)`, and the row type follows:

```ts file=db/enums.ts
import { defineDatabase, defineDomain, defineEnum, defineTable } from "@smonn/db";

const mood = defineEnum(["sad", "ok", "good"]);
const posint = defineDomain((c) => c.integer(), {
  notNull: true,
  checks: { posint_positive: "value > 0" },
});
const upbeat = defineDomain((c) => c.enum(mood), {
  checks: { upbeat_not_sad: "value <> 'sad'" },
});

export default defineDatabase({
  public: {
    mood,
    posint,
    upbeat,
    entries: defineTable((c) => ({
      id: c.text().notNull(),
      mood: c.enum(mood),
      score: c.domain(posint),
      lately: c.enum(mood).array().notNull(),
    })),
  },
});
```

Labels stay in the order you list them, which is the order the enum compares in. A domain's base is a bare type, such as `c.integer()`, or an enum, such as `c.enum(mood)`; it can't be an array or another domain. `notNull`, `default`, and `checks` (keyed by constraint name, with `value` naming the value checked) go in its options. Both also take `name` for an SQL name its key can't give.

Call `.array()` before any modifier, to make it a one-dimensional array of its type, as `lately` does. Only `.name()`, `.renamedFrom()`, `.index()`, and `.codec()` may come before it. Postgres can't make elements NOT NULL, so its row type is `("sad" | "ok" | "good" | null)[]`, and `.notNull()` and `.default()` apply to the whole column, as `.notNull()` does here. A builder query returns these arrays parsed, with `null` for a NULL element. Raw `sql` gets what postgres.js parses: an enum or domain array whose type existed when the connection opened arrives as an array of strings, with a NULL element as the string `"NULL"`, and one whose type was created later arrives as array text such as `{a,NULL}`. Open a new connection to get the first form.

### Codecs

A column's row type follows its Postgres type, so a `date` column reads as a `string`. `.codec()` swaps in another value. A Codec is `decode` from the column's base value and `encode` back to it, and only the query layer runs it: the driver, the catalog, and the migrations never see one, so adding or changing a codec generates nothing. `plainDate` ships with the package and maps `date` to `Temporal.PlainDate`. It reads `globalThis.Temporal` when it runs and throws if there is none. Node 24 has none, so install a Temporal polyfill first.

```ts wrap=module
import { plainDate, type Codec } from "@smonn/db";

const href: Codec<string, URL> = {
  decode: (base) => new URL(base),
  encode: (value) => value.href,
};

export default defineDatabase({
  public: {
    visits: defineTable((c) => ({
      id: c.text().notNull(),
      day: c.date().codec(plainDate).notNull(),
      page: c.text().codec(href),
      days: c.date().codec(plainDate).array().notNull(),
    })),
  },
});
```

`day` reads as a `Temporal.PlainDate`, `page` as `URL | null` since it is nullable, and `days` as `(Temporal.PlainDate | null)[]`. Codecs decode every value that comes from a column, as `from` selects and `insert ... returning` do, and encode insert values and any value you compare against the column. NULL never reaches a codec. One that throws rejects the query, naming the table and column. A raw `sql` query runs no codecs and returns base values. A column takes one codec.

On an array column, the codec belongs to the element, so call `.codec()` before `.array()`, as `days` does. It then runs on each element and skips NULL ones. `.array().codec(plainDate)` is a type error, since `.array()` leaves no `codec` method and a codec on a whole array isn't offered.

### Passing run-time values

A value binds when the statement is built, and a client takes no second argument. To run one statement with different values, write a function that builds it:

```ts file=by-email.ts
import { from, type Client } from "@smonn/db";
import db from "./db/definition.ts";

declare const client: Client;

const byEmail = (email: string) => from(db.public.users).where((u) => u.email.eq(email));

await client.all(byEmail("a@example.com"));
await client.all(byEmail("b@example.com"));
```

TypeScript types the parameters, and values go through column codecs as they do anywhere else. postgres.js caches a prepared statement per connection by its types and text, so both calls reuse one.

### Renaming a table, column, enum, or domain

Rename a key in the Definition and `generate` sees a drop and a create, which it flags as `data_loss`. It prints a hint when it spots a likely rename: a table that drops exactly one column and adds exactly one of the same type, a schema that drops exactly one table and adds one with identical columns, or an enum that drops exactly one label and adds one at the same position. With more than one drop or add, no hint appears, so check for renames yourself.

```text
hint: column "public"."users"."full_name" may be a rename of "name": add .renamedFrom("name") to it
```

Add the marker it names. A column takes `.renamedFrom("old_name")`:

```ts wrap=table
users: defineTable((c) => ({
  id: c.text().notNull(),
  full_name: c.text().renamedFrom("name"),
})),
```

A table takes `renamedFrom: "old_name"` in its second callback:

```ts wrap=table
people: defineTable(
  (c) => ({ id: c.text().notNull(), name: c.text() }),
  () => ({ renamedFrom: "users" }),
),
```

An enum and a domain take the same marker in their options, and an enum also takes `renamedLabels`, keyed new label to old. Without it, a renamed label is a type swap that rewrites every table using the enum, and `generate` prints a hint naming the entry to add. A domain check renames on its own when its expression stays the same.

```ts wrap=type
mood: defineEnum(["great", "bad"], {
  renamedFrom: "old_mood",
  renamedLabels: { great: "good" },
}),
posint: defineDomain((c) => c.integer(), { renamedFrom: "old_posint" }),
```

`generate` then writes `ALTER ... RENAME` in place of the drop and create, and keeps the data. Each table, column, enum, label, or domain rename carries the `rename` Hazard, because app code still on the old name breaks between `migrate` and its deploy.

```text
hazard rename: alter table "public"."users" rename column "name" to "full_name";
```

The marker takes the old SQL name, as the database holds it, not the old key. A hint is only a guess, and `generate` never writes one into the SQL, so a rename with no marker stays a drop and create.

Once you have run `commit`, the Committed migrations hold the new name and `generate` skips a marker whose old name is gone, so you can remove the marker or leave it. Until you commit, keep it: each `generate` rebuilds `current.sql` from the Definition, and without the marker the rename turns back into a drop. If both the old and the new name exist, `generate` throws.

### Mapping keys to snake_case

A key is its SQL name by default. Pass `casing` to map schema, table, column, enum, and domain keys to snake_case:

```ts wrap=module
export default defineDatabase(
  { public: { userAccounts: defineTable((c) => ({ userId: c.text().primaryKey() })) } },
  { casing: "snake_case" },
);
```

That table is `public.user_accounts`, its column `user_id`, and its primary key `user_accounts_pkey`, since derived names come from the SQL names. Enum labels, and the names you give constraints, indexes, and domain checks, stay as written. For a name casing can't produce, such as `user_ids` for `userIDs` (which maps to `user_i_ds`), a column takes `.name("sql_name")`, a table takes `name` in its second callback, and an enum or domain takes `name` in its options. An explicit name wins over casing. Two keys that map to one SQL name, such as `userId` and `user_id`, throw at load.

Builder queries return rows keyed by your keys. Raw `sql` returns the SQL names Postgres sends, so type its rows with those names, or as `DriverRow`.

Turning casing on for an existing database renames every name it changes, so each one needs a `renamedFrom` marker with its old SQL name. Without them, `generate` drops and recreates each table and column:

```ts wrap=table
userAccounts: defineTable(
  (c) => ({ userId: c.text().primaryKey().renamedFrom("userId") }),
  () => ({ renamedFrom: "userAccounts" }),
),
```

Schemas don't rename and take no `name`, so no marker saves a schema whose key casing changes: `generate` drops a schema `appData` and creates `app_data`. Turn casing on only once each schema's SQL name is one casing leaves as it is, such as `app_data`.

### Rebasing a Forked chain

When two branches each commit a Migration on the same tip, `migrate` and `verify` refuse the pair as a Forked chain. Merge the base branch into yours, then run `smonndb rebase`: it renumbers and rehashes each Committed migration the base branch lacks onto the base branch's tip, and leaves every other file as it is. `--onto <ref>` names the base branch, which defaults to the remote's default branch (`origin/HEAD`). It needs no database, does nothing on a straight chain, and can run unattended in CI. `actions/checkout` clones at depth 1 without `origin/HEAD`, so a CI job must fetch the base branch and pass `--onto`. It needs git 2.30 or newer, and refuses while git shows a changed, untracked, or gitignored top-level `.sql` file other than `current.sql`, or a `.sql.tmp` file, so git always holds what it rewrites. Each file is written under a temporary name and then renamed into place. If a run fails or stops partway, run `smonndb rebase` again: it names the files to set aside with `git stash`, and the run after that finishes. A Dev database that applied a moved file no longer matches the files, so the next `generate` diffs it to them.

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

`pnpm check` runs every check CI runs, keeps going after a failure, and exits non-zero if any failed. It needs the test database above. `pnpm check:static` runs all of them but the tests, and needs no database. Each check is also its own script in `package.json`. Baselines recorded at adoption (2026-10-22) only go down: `complexity`, `max-params`, and `max-depth` sit at their targets of 6, 4, and 4 (the comment beside `complexity` in `.oxlintrc.json` records that the target is reached), `fta-baseline.json` holds any file fta lets score above 60, and raising a baseline needs the maintainer. oxfmt formats TypeScript and Markdown, knip reports unused files, exports, and dependencies, `deps` finds duplicated code, and `fta` scores file maintainability.

`pnpm install` installs the [lefthook](https://lefthook.dev) hooks in `lefthook.yml`. The pre-commit hook runs `oxlint --fix` and `oxfmt` on the staged files and stages their fixes, then runs the fta score check (`pnpm fta`) and the import rules, cycles included (`pnpm check:imports`), so a breached limit fails the commit. The pre-push hook runs `pnpm check:static`, a check that each pushed branch name is a Conventional Branch or a never-merged `research/` or `prototype/` branch (`pnpm check:branch`), and the unit tests changed since `origin/main`; the database tests run in CI.

## Learn more

- [Glossary](GLOSSARY.md): the project's vocabulary.
- [Architecture](docs/architecture/README.md): modules, ports, and import rules, with the CLI and the diff engine.
- [Architecture decisions](docs/adr/): what was decided and why.

## License

[Apache-2.0](LICENSE)
