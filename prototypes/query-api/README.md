# PROTOTYPE: Query API shape for v0.1

Throwaway code for [Query API shape for v0.1](https://github.com/smonn/db/issues/6). It lives on the `prototype/query-api` branch and is never merged.

**Question:** what do `from`, `where`, `select`, and `insert` look like under ADR-0004, and does their inference stay correct and fast on TypeScript 7?

## Run

```sh
npm install
npm run check    # tsc 7: checks.ts must infer every result type and reject every misuse
npm run demo     # prints the SQL and parameters each variant sends
npm run stress   # generates 20 tables x 40 columns with 440 statements, then times the check
```

## Outcome

Pending the maintainer's pick.

## What both variants share

The builder lives in [query.ts](query.ts). It works on the rolled-up tables from the [Definition](db.ts) (`db.public.users`).

```ts
from(users)
  .where((u) => u.age.gte(18).and(u.is_admin.eq(false)))
  .select((u) => ({ id: u.id, name: u.display_name }));
// select "id", "display_name" as "name" from "public"."users" where ("age" >= $1 and "is_admin" = $2)

insert(orders).values([{ user_id, total, placed_on }]).returning("id");
// insert into "public"."orders" ("user_id", "total", "placed_on") values ($1, $2, $3) returning "id"
```

- Column objects carry the operators: `eq`, `ne`, `in` on every column; `gt`, `gte`, `lt`, `lte` on numbers, bigints, strings, and dates; `like`, `ilike` on text.
- `eq(null)` never type-checks. Only nullable columns have `isNull()` and `isNotNull()`.
- `bigint` columns compare to `1n`, not `1`.
- With no `select`, a Query returns `Row<T>`. Repeated `where` calls are joined with `and`.
- `select` takes an object callback (which allows aliases) or a list of column names.
- Predicates combine through methods (`a.and(b)`, `a.or(b)`, `a.not()`) or through `where`'s second argument (`(u, { and, or, not }) => or(a, b, c)`).
- `insert(t).values(row | rows)` takes `NewRow<T>`, writes `default` for keys a row leaves out, and accepts `.returning(...)` in the same two forms as `select`.
- Names are quoted and sent as-is. Table and schema names stay typed as `string`: SQL rendering reads them at runtime, so the types never need literals.

## Variants

| Variant | Running a statement | Without a database |
| --- | --- | --- |
| [A query values](a-query-values/lib.ts) | `client.all(q)`, `client.one(q)`, `client.run(insert)` | `from(...)` and `insert(...)` are plain imports; `q.toSql()` |
| [B bound client](b-bound-client/lib.ts) | `await db.from(...)...`, `.one()` | needs a Driver to build anything |

**A** keeps statements as data: they can be built at module scope, tested with `toSql()` alone, and passed to a transaction's client unchanged. Running one takes a second call.

**B** reads like Drizzle and Kysely. But each root (client, transaction) needs its own builders, and an insert you forget to `await` never runs.

B is a thin layer over A, so A can gain B's sugar later without a breaking change. Removing B after release would be a breaking change.

## Findings

- Type check of [checks.ts](checks.ts) on TypeScript 7.0.2: 0.007s check, 0.019s total, 10,220 instantiations.
- Stress (20 tables of 40 columns, 440 statements): 0.086s check, 0.100s total, 78,484 instantiations, 56 MB.
- Each `@ts-expect-error` fails for the intended reason. Mistyped operands name the expected type (`'string' is not assignable to ... 'number | Ref<number, boolean>'`). Missing operators read `Property 'isNull' does not exist on type 'ColumnRef<string, false>'`.
- Messages that need work: `select("nope")` only reports `No overload matches this call` because `select` is overloaded. Insert errors print the whole `Table<...>` type.
- `u.age > 18` is rejected, since it is a boolean rather than a Predicate. TypeScript also reports that `>` does not apply to a column object.

## Not covered

`orderBy`, `limit`, joins, `update`, `delete`, the typed `sql` template, transactions, and decoding values through codecs.
