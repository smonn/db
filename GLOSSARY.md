# smonn/db

A Postgres-first TypeScript toolkit for defining a database, migrating it with plain SQL, and querying it with SQL-shaped code. Terms follow the PostgreSQL manual wherever it has one.

## Language

### Structure

**Database**:
One Postgres database that the project defines, migrates, and queries. A project may hold several.

**Schema**:
A Postgres namespace that groups tables and other objects inside a Database, such as `public`.
_Avoid_: Namespace

**Definition**:
The TypeScript description of a Database's desired tables and other objects, from Postgres's "data definition". Not the Schema, which groups objects inside a Database.
_Avoid_: schema file

**Unmodeled object**:
A database object of a kind the Definition cannot express yet, such as a trigger, left untouched by generated Migrations.

### Migrations

**Migration**:
A plain SQL file that moves a Database forward from one structure to the next.

**Committed migration**:
A Migration frozen into the project's ordered, forward-only history.
_Avoid_: Applied migration

**Current migration**:
The single in-progress Migration, regenerated from the Definition and reapplied to the Dev database while you iterate, until it is committed.
_Avoid_: Draft, pending migration

**Forked chain**:
Two or more Committed migrations that follow the same file, naming its Hash in `--! Previous:`, or that each start the chain with `--! Previous: -`. Two branches that each commit a Migration on the same tip leave one; `verify` names it, and `rebase` moves the branch's files onto the base branch's tip.

**Tracking schema**:
The Schema where the migrator records Committed migrations in `migrations`, and where Dev code records the Current migration in `current`. It is `smonn_db` unless configured, and the Diff skips it.

**Shadow database**:
A throwaway Database built by replaying the Committed migrations, used as the "before" state when generating the Current migration.

**Definition database**:
A throwaway Database built from the Definition alone, used as the "after" state when generating the Current migration.
_Avoid_: Target database, template database, desired database

**Dev database**:
The Database a developer iterates against, which holds the Current migration and may be rebuilt at any time, losing its data.
_Avoid_: Local database

**Hazard**:
A risk a generated change carries when it runs, such as data loss, a table rewrite, or a lock that blocks reads and writes.

### Data

**Statement**:
One SQL statement that the query builder or `sql` produces, ready to run on a Database. A Query and a Data modification are both Statements.

**Query**:
A Statement that returns rows, such as a `SELECT` or an `INSERT ... RETURNING`. Not a Data modification that only reports a count.

**Data modification**:
An `INSERT`, `UPDATE`, or `DELETE` statement that changes rows and reports a count.
_Avoid_: Mutation

**Row**:
A row of a table as the Definition types it: each column maps to its value type, nullable where the column allows NULL. Not the Driver row.

**Driver row**:
A row exactly as a driver returns it, with unknown values. Not the Row, which the Definition types.
_Avoid_: Raw row
