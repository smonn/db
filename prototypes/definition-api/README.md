# PROTOTYPE: Definition API shape

Throwaway code for [Definition API shape](https://github.com/smonn/db/issues/5). It lives on the `prototype/definition-api` branch and is never merged.

**Question:** how does a user declare a Definition (schemas, tables, columns, primary keys), and how are row types inferred from it?

## Run

```sh
npm install
npm run check   # tsc 7: every variant must infer the rows in expected.ts and reject the bad Definitions in checks.ts
npm run demo    # loads each Definition the way the CLI would and prints the catalog the diff receives
```

## Outcome

The maintainer picked **[D hybrid](d-hybrid/)**, a mix of B and C:

- `defineTable((c) => ({ ... }), { primaryKey? })` takes a column callback and no name. Each table can sit in its own file.
- One Definition file, named in config, default-exports `defineDatabase({ public: { users, orders }, auth: { sessions } })`. Its keys name the schemas and tables, and queries use the rolled-up tables (`db.public.users`).
- Columns are nullable unless marked `.notNull()`, as in SQL. `.primaryKey()`, composite key columns, and identity columns are NOT NULL implicitly, as in Postgres.
- Keys are the SQL names, with no mapping. A mapping layer and renames come after v0.1.

Variant D's type check covers all four variants together: 0.009s check, 0.022s total, 15,395 instantiations. Its catalog matches A, B, and C.

## Variants

A, B, and C (below) came first. All three declare the same Database (`public.users`, `public.orders`, `auth.sessions`) with all 15 v0.1 column types, and share one column model (`core.ts`). They differ only in structure.

| Variant | Shape | CLI finds tables by |
| --- | --- | --- |
| [A flat tables](a-flat-tables/definition.ts) | `export const users = table("users", { ... })`, `schema("auth").table(...)` | collecting every exported table |
| [B database object](b-database-object/definition.ts) | `export default database({ public: { users: table({ ... }) } })`, names from keys | reading the default export |
| [C column callback](c-column-callback/definition.ts) | like A, but `table("users", (c) => ({ id: c.uuid() }))`: no factory imports | collecting every exported table |

## Shared choices (open for the maintainer too)

- Columns are `NOT NULL` unless marked `.nullable()`.
- The object key is the SQL column name, with no camelCase mapping.
- A single-column primary key goes on the column, a composite one in table options. Using both throws when the Definition loads.
- `Row<typeof users>` is what a Query returns. `NewRow<typeof users>` is what an INSERT accepts: columns with defaults and nullable columns are optional, and identity columns are left out.
- Value types: `bigint` is a `bigint`, `numeric` a `string`, `date` a `string`, `timestamp`/`timestamptz` a `Date`, `jsonb<T>` a `T`, and `bytea` a `Uint8Array`.

## Findings

- Type check of all three variants on TypeScript 7.0.2: 0.007s check, 0.037s total, 7,447 instantiations.
- `NoInfer` on table options keeps a composite primary key from steering inference, so `primaryKey: ["nope"]` reports `'"nope"' is not assignable to type '"id"'` in all three variants.
- A nullable primary key is rejected, but the message is a generic "Expected 1 arguments". The hover shows the real reason.
