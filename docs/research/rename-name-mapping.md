# Prior art for renames and TS-to-SQL name mapping

Research for issue #371 (map #370), feeding the decision ticket #379. Facts only: no design is recommended here. Gathered 2026-10-24 from official docs and source code. Each claim carries its source; "(inferred)" marks a reading of code I did not run, and "not verified" marks a gap.

## Context in this repo

- ADR-0010 uses Definition keys verbatim as SQL names, and a renamed key is a drop plus a create flagged `data_loss`.
- The catalog leaves each fact's own name out of its payload, and keys it by the chain of names. Primary key and unique constraint facts are named by their constraint, defaulting to `users_pkey` and `users_email_key` (`docs/architecture.md`, Diff engine > Catalog).
- Diff compares two introspected databases (ADR-0013), so the diff never sees the Definition's TypeScript keys, only SQL names.

## Summary table

| Tool                     | TS-to-SQL name mapping                                                       | How a rename is expressed                                                     | Derived constraint and index names                                                            | Result row keys                                                        |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Drizzle (0.45 and v1 rc) | Explicit alias per column, or a `casing` setting (`snake_case`, `camelCase`) | Prompt at `generate` time; v1 adds answers passed as JSON hints               | Built from the column names; with casing, patched by string replace (0.45)                    | Positional: rows are read as arrays and keyed by the selected TS field |
| Prisma (classic)         | Explicit `@map` / `@@map`; no automatic casing                               | Not detected; default is drop plus create, user edits the generated SQL       | Built from database names, not model names                                                    | Client exposes the schema's field names                                |
| Prisma Next              | Not examined                                                                 | Planner asks; `--rename old:new` or `--delete`; fails in non-interactive runs | Not examined                                                                                  | Not examined                                                           |
| Atlas                    | None found; HCL and SQL carry SQL names                                      | Both: prompt at `migrate diff`, and declared `renamed_from`                   | Its scratch database may produce other names; `diff.skip.rename_constraint` hides the renames | Not applicable (no query layer)                                        |
| Kysely                   | `CamelCasePlugin`, an automatic function over every identifier               | Hand-written migration (`renameColumn`, `renameTo`, `renameConstraint`)       | User writes DDL; no derivation                                                                | Plugin camelCases every returned row key                               |
| pgroll                   | None; names are JSON strings                                                 | Declared operation in the migration file                                      | Column rename only renames the column                                                         | Not applicable; per-version views expose names                         |
| Graphile Migrate         | None                                                                         | Hand-written SQL                                                              | Not applicable                                                                                | Not applicable                                                         |

## 1. Drizzle

Two lines exist: `main` is the 0.45 line (latest release 0.45.4) and `beta` is v1 (latest release v1.0.0-rc.5) ([releases](https://github.com/drizzle-team/drizzle-orm/releases)). Findings differ between them.

**Mapping.**

- The schema docs say that, by default, "Drizzle will use the TypeScript key names for columns". A column alias maps to another name (`firstName: varchar('first_name')`). The docs now describe `snakeCase` / `camelCase` builders that map keys automatically ([schema docs](https://orm.drizzle.team/docs/sql-schema-declaration)). I did not find those builders exported from `pg-core/index.ts` on `beta`, so where they live is not verified ([beta index](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-orm/src/pg-core/index.ts)).
- 0.45 `main`: a `CasingCache` converts column names only, never table names. An explicit name wins: `getColumnCasing` returns `column.name` untouched when `keyAsName` is false ([casing.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/casing.ts)).
- v1 `beta`: casing is applied when the table is defined. `setName` sets the column name to `casingFn(key)` only when no explicit name is set ([column-builder.ts](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-orm/src/column-builder.ts), [table.ts](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-orm/src/pg-core/table.ts)). The word split uses a Unicode-aware regex ([casing.ts, beta](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-orm/src/casing.ts)).
- `drizzle.config` `introspect.casing` (`preserve` or `camel`) covers the other direction, naming keys when pulling an existing database ([config docs](https://orm.drizzle.team/docs/drizzle-config-file)).

**Rename.** Prompted at generate time; the Definition holds no rename marker.

- The kit's own flow diagram lists "prompt developer for renames if necessary" ([generate docs](https://orm.drizzle.team/docs/drizzle-kit-generate)).
- 0.45: for each table, `promptColumnsConflicts` skips the prompt when there are no new columns or no missing columns. Otherwise it asks, per new column, whether it is created or renamed from one of the missing columns ([migrate.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/cli/commands/migrate.ts), prompt text in [views.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/cli/views.ts)).
- v1: answers can be passed as JSON with `--hints` or `--hints-file`. A hint is `rename` (from, to), `create`, or `confirm_data_loss`, for kinds including table, column, default, schema, enum, sequence, view, policy, role, check, index, unique, primary_key and foreign key. Unanswered cases are reported as `missing_hints` ([hints.ts](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-kit/src/cli/hints.ts), [cli/schema.ts](https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-kit/src/cli/schema.ts)). The hint lives in the command, not in the Definition.
- A feature request asks for non-interactive conflict resolution ([issue #5307](https://github.com/drizzle-team/drizzle-orm/issues/5307)). What the 0.45 prompt does without a TTY is not documented.

**Derived names.**

- Defaults: primary key `${table}_${cols}_pk`, unique `${table}_${cols}_unique`, foreign key `${table}_${cols}_${foreignTable}_${foreignCols}_fk`. An explicit `name` replaces them ([primary-keys.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/primary-keys.ts), [unique-constraint.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/unique-constraint.ts), [foreign-keys.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/foreign-keys.ts)).
- 0.45 builds those defaults from the TS-side column name. The serializer then rewrites them with `name.replace(originalColumnName, casedName)` when `casing` is set ([pgSerializer.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/serializer/pgSerializer.ts), lines 277-349). That replace hits the first occurrence of the substring (inferred).
- Unique names are checked for duplicates within a table, and the kit exits on a clash (same file).

**Result keys.** Result rows arrive as arrays and `mapResultRow` assigns each value to its selected field's path, so no runtime name lookup happens ([utils.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/utils.ts)).

## 2. Prisma

**Mapping.** No automatic casing. `@map` and `@@map` set the database name for a field or model, and the client keeps the schema name (`prisma.comment.content`, not `comment_text`). Enums map the same way, and the generated TypeScript keeps the schema names ([database mapping, v6](https://www.prisma.io/docs/orm/v6/prisma-schema/data-model/database-mapping)).

**Derived names.**

- Defaults: `{table}_pkey`, `{table}_{columns}_key`, `{table}_{columns}_idx`, `{table}_{columns}_fkey`. "Prisma ORM always uses the database names of entities when generating the default index and constraint names", so `@map` / `@@map` supply the input, not the model or field name (same page).
- A `map:` argument on `@id`, `@@id`, `@unique`, `@@unique`, `@@index` and `@relation` sets a custom name. Introspection writes `map` only when the name differs from the default (same page).
- The same page's example lists `User_pk` against the `_pkey` convention in its table; the page is inconsistent.

**Rename (classic Migrate).** Not detected and not prompted. "By default, renaming a field in the schema results in a migration that will CREATE a new column ... DROP the existing column ... and the data". The user runs `migrate dev --create-only` and edits the generated SQL to a single `RENAME COLUMN` (`sp_rename` on SQL Server) ([customizing migrations, v6](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/customizing-migrations)).

**Rename (Prisma Next).** A separate, newer docs tree. The planner cannot tell on its own whether a model, a field or (on PostgreSQL) a Schema was renamed. It asks before writing; answer with `--rename <old>:<new>` or `--delete`. Non-interactive runs fail with `CLI.CONSENT_REQUIRED` and list the flags ([Prisma Next, generating a migration](https://www.prisma.io/docs/orm/next/migrations/generating-a-migration)). That page also notes "`db migrate` runs destructive operations without asking". Its maturity is not stated on the page.

## 3. Atlas

**Mapping.** Atlas is not an ORM. The HCL and SQL examples I read use SQL names directly and show no casing option; this is an absence in the pages read, not a confirmed property.

**Rename.** Both styles exist.

- Prompt: at `atlas migrate diff`, "Did you rename "users" column from "first_name" to "name"" with Yes or No. No produces a drop and a create. The post says it is "impossible to completely disambiguate between RENAME and DROP and ADD" and does not describe the heuristic ([v0.22 post](https://atlasgo.io/blog/2024/05/01/atlas-v-0-22)).
- Declared: `renamed_from = "old"` on a table, column or index in HCL, or `-- atlas:renamed_from old` above the object in SQL. The planner then emits `ALTER ... RENAME` "without prompts". The page calls the prompt "a human-only contract: agents cannot answer it" ([declarative schema renames](https://atlasgo.io/changelog/declarative-schema-renames), dated 2026-05-20). It does not say whether the annotation can be removed after the rename applies.
- The BC102 lint analyzer flags column renames as backward-incompatible ([analyzers](https://atlasgo.io/lint/analyzers), as summarized by search; page not read in full).

**Derived names.** Atlas loads the desired schema into a scratch database it calls the "dev-database". "Since the dev-database may generate different constraint names than the live database", it can emit constraint `RENAME` statements, typically for unnamed constraints from ORMs. `diff.skip.rename_constraint = true` suppresses them ([FAQ](https://atlasgo.io/faq/skip-constraint-rename)).

**Result keys.** Not applicable.

## 4. Kysely

**Mapping.** `CamelCasePlugin` is an automatic function, not a per-key declaration.

- Queries: a transformer snake-cases every `IdentifierNode` in the query tree (tables, columns, schemas, aliases) ([camel-case-transformer.ts](https://github.com/kysely-org/kysely/blob/master/src/plugin/camel-case/camel-case-transformer.ts)). Raw SQL text outside identifier nodes is not touched (inferred). The doc says "everything needs to be defined in camelCase in the TypeScript code" ([plugin source](https://github.com/kysely-org/kysely/blob/master/src/plugin/camel-case/camel-case-plugin.ts)).
- Results: `mapRow` camelCases every key of every row, and recurses into nested plain objects and arrays unless `maintainNestedObjectKeys` is set (same file).
- Options: `upperCase`, `underscoreBeforeDigits`, `underscoreBetweenUppercaseLetters`, `maintainNestedObjectKeys`; `snakeCase` and `camelCase` methods can be overridden. The doc examples show lossy cases: `fooBAR` becomes `foo_bar` by default and `foo_b_a_r` with the option on ([plugin source](https://github.com/kysely-org/kysely/blob/master/src/plugin/camel-case/camel-case-plugin.ts), [camel-case.ts](https://github.com/kysely-org/kysely/blob/master/src/plugin/camel-case/camel-case.ts)).

**Rename.** Kysely does not diff. A migration is a hand-written TypeScript file with `up` and `down` ([migrations docs](https://kysely.dev/docs/migrations)). The schema builder has `renameTo`, `renameColumn` and `renameConstraint` on `AlterTableBuilder` ([API](https://kysely-org.github.io/kysely-apidoc/classes/AlterTableBuilder.html)).

**Derived names.** None; the migration author names or leaves to Postgres. Whether the plugin also changes constraint names passed to the schema builder is not verified.

## 5. pgroll

**Mapping.** None. Names are strings in JSON or YAML migration files. Its mechanism for presenting different names is a Postgres schema per migration version containing views over the real tables ([concepts](https://github.com/xataio/pgroll/blob/main/docs/concepts.md)).

**Rename.** Declared as an operation: `rename_table`, `rename_column`, `rename_constraint`. In the new version the column has the new name and the old version keeps the old name. The physical rename happens at migration completion, when the old schema is dropped ([rename column](https://github.com/xataio/pgroll/blob/main/docs/operations/rename_column.mdx), [rename table](https://github.com/xataio/pgroll/blob/main/docs/operations/rename_table.mdx), [rename constraint](https://github.com/xataio/pgroll/blob/main/docs/operations/rename_constraint.mdx)).

**Derived names.** `OpRenameColumn.Complete` emits one DB action, the column rename. It rewrites column names inside constraints only in pgroll's in-memory schema, not in Postgres ([op_rename_column.go](https://github.com/xataio/pgroll/blob/main/pkg/migrations/op_rename_column.go)). Table rename likewise emits one rename ([op_rename_table.go](https://github.com/xataio/pgroll/blob/main/pkg/migrations/op_rename_table.go)).

**Result keys.** Not applicable.

## 6. Graphile Migrate

No mapping and no Definition. Migrations are plain SQL in `current.sql` and `committed/`, roll-forward only, and "no custom DSL to learn" ([README](https://github.com/graphile/migrate/blob/main/README.md)). A rename is whatever SQL the author writes. The README gives a rename as its example of drift: `watch` reruns `current.sql` on save, so renaming a function there creates the new one and leaves the old one behind in the developer's database, and the leftover never reaches production or the database it rebuilds from migrations (same README, "Drift").

## 7. Postgres facts that bound every design above

- `ALTER TABLE ... RENAME` changes a table, a column or a constraint; "when renaming a constraint that has an underlying index, the index is renamed as well." The page does not say a table or column rename touches names of constraints, indexes or sequences derived from the old name ([ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)). pgroll's source above emits only the one rename.
- A primary key or unique constraint creates an index with the constraint's name, and index names are unique per schema. Without a name, "the system generates a name" ([CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)).

## 8. Gaps

- pgroll's docs site renders client-side, so I read the same pages in the repo's `docs/` directory.
- Prisma and Drizzle have several live version lines; the claims above name the line they come from.
- I did not run any tool. Atlas's rename heuristic, Drizzle `snakeCase` builder location, and Kysely plugin behavior on constraint names passed to the schema builder are unverified.

## Open questions for #379

1. Where does a rename live: in the Definition (Atlas `renamed_from`), in a generate-time answer (Drizzle and Atlas prompts, Drizzle v1 hints, Prisma Next `--rename`), or only in hand-edited SQL (Prisma classic, Kysely, pgroll, Graphile Migrate)? Diff reads two introspected databases (ADR-0013), so a Definition marker or an out-of-band answer has to reach it somehow.
2. Does a declared rename stay in the Definition after the migration commits, or is it per run? Atlas's docs do not say; Drizzle hints and Prisma Next flags are per run.
3. Which objects can be renamed: tables and columns only, or also indexes (Atlas), constraints, enums and more (Drizzle v1)?
4. When a table or column renames, do the derived `users_pkey`, `users_email_key` and similar names follow, or keep the old name? Postgres leaves them; pgroll leaves them; Atlas adds constraint renames and offers a switch to skip them. The catalog keys constraints by name and refuses clashing derived names, so a stale name would be a visible diff.
5. Do derived names come from the TypeScript key, the SQL name, or the mapped SQL name? Drizzle derives from the TS side then patches (0.45); Prisma derives from the database names.
6. Is the mapping an automatic function or a per-key declaration, or both with an override? Drizzle and Prisma let an explicit name win; Kysely has no per-key override. Automatic functions are lossy for some keys (`fooBAR`, digits), so the question includes what round-trips.
7. What does the mapping cover: columns only (Drizzle 0.45), also tables and schemas (Kysely, Prisma `@@map`)?
8. Where do result keys map: positionally by selected field (Drizzle), by a transform over every returned key including aliases and nested JSON (Kysely), or by a generated client (Prisma)? How does that meet the glossary's Row versus Driver row, and raw `sql` text?
9. What does a non-interactive run (CI, an agent) do on an ambiguous rename: fail (Prisma Next), accept a hint (Drizzle v1), take the declaration (Atlas), or something undocumented (Drizzle 0.45)?
10. How does a prompt pair candidates when several columns are new and several are missing, and can a rename combine with a type change in one step? Drizzle's prompt pairs one new column against all missing ones; Atlas's heuristic is undocumented.
11. Does the Current migration, regenerated from the Definition and reapplied to the Dev database, need to treat a rename specially? Graphile Migrate documents a drift case for renames under repeated reapplication.
12. Is a zero-downtime rename (pgroll's two-version views) in scope for v0.2, or only a roll-forward rename?
