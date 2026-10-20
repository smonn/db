---
status: accepted
---

# Production migrations run from the runtime

A small migrator in the zero-dependency runtime applies Committed migrations, callable from app startup or a deploy script; the CLI's `migrate` command wraps it. It holds a Postgres advisory lock so parallel instances cannot race. Production deploys then need nothing beyond the app itself, and because Migrations are portable SQL (ADR-0002), dbmate stays a fallback that needs none of this library.
