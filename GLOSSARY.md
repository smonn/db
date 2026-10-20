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
The TypeScript description of a Database's desired tables and other objects, from Postgres's "data definition".
_Avoid_: Schema, model, schema file

**Unmodeled object**:
A database object of a kind the Definition cannot express yet, such as a trigger, left untouched by generated Migrations.

### Migrations

**Migration**:
A plain SQL file that moves a Database forward from one structure to the next.

**Committed migration**:
A Migration frozen into the project's ordered, forward-only history.
_Avoid_: Applied migration

**Current migration**:
The single in-progress Migration, regenerated from the Definition and reapplied to the dev Database while you iterate, until it is committed.
_Avoid_: Draft, pending migration

**Shadow database**:
A throwaway Database built by replaying the Committed migrations, used as the "before" state when generating the Current migration.

### Data

**Query**:
A `SELECT` statement that retrieves rows.

**Data modification**:
An `INSERT`, `UPDATE`, or `DELETE` statement that changes rows.
_Avoid_: Mutation
