---
status: accepted
---

# Migration file format

Each Committed migration is one file named with a fixed-width sequence and a slug, such as `000001-create-users.sql`. It holds a hash-chain header, a `-- migrate:up` marker (optionally with `transaction:false`), the SQL, and an empty `-- migrate:down` marker. The markers make every file valid for dbmate, which requires both even when the down section is empty, keeping ADR-0002's portability promise. The hash chain links each file to the one before it, so a Migration merged out of order from a parallel branch fails loudly instead of applying in an order nobody tested.

## Considered Options

- **Timestamped names without a chain (dbmate's default)**: parallel branches merge silently in whatever order git produces.
