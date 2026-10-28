# Prototype: v0.3 decision probes

Throwaway probes for #672 (map #652). Each closed decision got its own probe branch, built from `main`, with the decided shape, at least one alternative, tsc error texts, instantiation cost, and Postgres 18.6 runs.

| Decision                        | Branch                                 | README                     |
| ------------------------------- | -------------------------------------- | -------------------------- |
| #655 order, limit, `in`, `like` | `prototype/v03-decision-probes-order`  | [order](order/README.md)   |
| #657 update and delete          | `prototype/v03-decision-probes-mutate` | [mutate](mutate/README.md) |
| #658 joins                      | `prototype/v03-decision-probes-joins`  | [joins](joins/README.md)   |

This branch holds only the READMEs. The code doesn't merge into one tree: each probe changes `Column`'s positional type parameters in `definition/column.ts` a different way (`order` replaces `Int` with `Kind`, `mutate` widens `Gen` to carry the identity mode, `joins` adds an `Sql` class), so a merged tree would test no single proposal. Read the code with `git diff main <branch>`.
