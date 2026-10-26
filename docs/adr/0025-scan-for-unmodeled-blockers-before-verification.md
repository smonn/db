---
status: proposed
---

# Generate scans for Unmodeled blockers before verification

Before verifying the Current migration in the Shadow, generate walks `pg_depend` from each table, column, constraint, index, enum, or domain the diff drops or retypes, and stops with every Unmodeled object in the way. Verification runs the body as one query and reports only the first failing statement's blockers, so the user fixes one and reruns to find the next, a loop v0.2's foreign keys, index rebuilds, and type swaps make longer. Verification stays the backstop and Postgres keeps the final word, since a hand-rolled walk can disagree with it.

## Considered Options

- **Scan instead of mapping Postgres's errors**: one reporter, but the scan misses inheritance children and can name a different retype blocker than Postgres, so its gaps would reach the user as unmapped errors.
- **Pre-check in `migrate` against another Database**: the only place a scan sees blockers the Shadow lacks, but it puts introspection in the zero-dependency runtime, while the per-file transaction already rolls a blocked file back. A dev-side command suits it better, if anyone asks.
- **Scan a hand-edited `current.sql`**: the edit is usually the fix for a blocker, so scanning the generated actions reports blockers it removed, and scanning the edit means parsing or running it, which verification does.

## Consequences

- The scan runs in `diffInShadow` after `diff`, reading the Shadow. When it finds blockers, generate stops without running verification. When it finds none, verification runs as before, and its mapped error covers what the scan missed.
- Drops use the transitive walk from the `pg_depend` research, where only `n` edges block. Column type changes, including each column a type swap retypes, use a second query over direct dependents, which mirrors `ALTER COLUMN TYPE`'s refusals. Defaults, identity, `NOT NULL`, and expression changes get no scan.
- A dependent is a blocker unless the plan itself drops or rebuilds it, so a modeled foreign key or index that generate drops first is not reported. The scan reads the set of actions, not their order.
- The scan reads no `pg_inherits`. Inheriting children and partitions reach the user through verification until the Definition models them.
- Messages name each blocker by kind and qualified name from `pg_identify_object`, which ignores `lc_messages`, in our own English. They don't say which version plans to model the kind, which ADR-0005 allows, since that table would drift with the roadmap.
- The `2BP01` and `0A000` mapping moves into `runtime/` as pure code shared by generate and `migrate`, and covers every `0A000` "cannot alter type of a column used by" variant, not only views. Generate's hint stays a hand edit of the Current migration. `migrate`'s names the file and its blockers, says the file rolled back, and points to a new migration, since a Committed file is hashed.
- ADR-0005 holds: the scan only reports, and generated SQL still never uses `CASCADE` (ADR-0013).
