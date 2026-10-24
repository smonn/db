# PROTOTYPE: Foreign key Definition API

Throwaway code for [Foreign key Definition API and diff](https://github.com/smonn/db/issues/374). It lives on the `prototype/foreign-keys` branch and is never merged.

**Question:** how does a Definition point columns at another table's key, so the types catch a mismatch, import cycles still load, and `defineDatabase` can name both tables in an error?

## Run

From the repo root (it uses the repo's TypeScript 7):

```sh
pnpm exec tsc -p prototypes/foreign-keys   # every variant compiles; checks.ts holds the rejected mistakes
node prototypes/foreign-keys/demo.ts       # prints each variant's foreign key DDL and what defineDatabase refuses
```

## Variants

Every variant declares the same five tables: `users` and `orders` point at each other from two files that import each other, `categories` points at itself, and `shipment_events` points at the composite key of `shipments`. `core.ts` holds the shared column model and `resolve`, which `defineDatabase` calls to turn declarations into catalog facts.

| Variant                               | Shape                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A column](a-column/tables/orders.ts) | `user_id: c.integer().notNull().references(() => users.columns.id, { onDelete: "cascade" })`                                                      |
| [B table](b-table/tables/orders.ts)   | second callback: `foreignKeys: [{ columns: [t.user_id], references: () => [users.columns.id], onDelete: "cascade" }]`; self: `references: [t.id]` |
| [C both](c-both/db.ts)                | A for a single column to another table, B for composite and self references                                                                       |
| [D database](d-database/db.ts)        | `defineDatabase(schemas, ({ public: db }) => ({ foreignKeys: [{ columns: [db.orders.user_id], references: [db.users.id] }] }))`                   |

## Findings

- **Every in-table form needs one annotation per reference cycle.** A, B, and C all fail with TS7022 (`'orders' implicitly has type 'any'`) when two tables point at each other, or when a column points at its own table. Inferring a thunk's return type from its body ties the two tables' types together, generic or not. One annotation per cycle fixes it: `(): Target<number> => orders.columns.id`. That is Drizzle's `AnyPgColumn` workaround, but `Target<V>` keeps the value check. D never needs one, because the tables are already values.
- **B and C handle self references without annotations**, through the table's own refs (`references: [t.id]`).
- **Column-level errors are the best.** A wrong target in A or C reports at the target in three lines: `Type 'Column<number, true, true>' is not assignable to type 'Target<string>'` ... `'number' is not assignable to 'string'`. B and D report on the whole callback with a 10-line chain, and the reason sits on the last line.
- **"Not a key" reads poorly everywhere:** `'false' is not assignable to type 'true'`. A named brand (such as `key: "primary key or unique"`) would fix it in any variant.
- **The types check:** value type per column pair (`uuid` to `integer` fails, and so does `bigint` to `integer`, which Postgres allows), that a single target is a primary key or unique column, the column count, and that a self reference names one of its own keys.
- **`defineDatabase` checks at runtime:** a target table outside the Database, a composite target that isn't a key, a `defineTable` value rolled up twice (the prototype refuses this even without a foreign key to it; the real check should refuse only a target), a name over 63 bytes, and two foreign keys with one name on one table. Messages name both tables, such as `the foreign key on public.pointsAtLoose (x) points at a table that is not in the Database; add it to defineDatabase`.
- **All four variants produce the same facts** (A only the two it can express). Check time across all four: 0.019s check, 0.037s total, 37,992 instantiations.

## #351's three points

1. **Two `Refs` types:** foreign targets are `Column` values (`users.columns.id`), not refs, so Definition refs stay inside the second callback. Renaming the Definition one to `ColumnRefs` still frees `Refs` for the query layer.
2. **The invariant `"~table"` brand:** it stays. A foreign target is a different type, `Target<V>`, which takes any table's key column on purpose. `defineDatabase` finds its table by identity and names both tables in errors.
3. **`ColumnState.constraintName`:** `.references()` gets its own `references` slot, with the name in its options.

## Outcome

The maintainer picked **[C both](c-both/db.ts)**: it follows ADR-0010's primary key rule (one column on the column, a composite key in the second callback), and the common case reads like SQL's `references users (id)`. Two diff decisions came with it:

- Adding a foreign key to an existing table gets a new Hazard kind for the write lock. Splitting it into `NOT VALID` then `VALIDATE` waits on [Migrations can't opt out of a transaction](https://github.com/smonn/db/issues/375).
- `introspect` treats a `NOT VALID` foreign key as the same fact. That ticket revisits whether diff should emit `VALIDATE` for one.
