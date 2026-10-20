---
status: proposed
---

# Modules grouped by future package, with host access behind ports

Source is grouped by the package each module would move to (`runtime/`, `adapters/`, `dev/`), so ADR-0006's later workspace split becomes a folder move. Only adapters and the CLI's composition root touch `node:*` or Node globals; everything else reaches the database and filesystem through ports whose types live in `runtime/ports`, which keeps Deno and Bun possible without auditing the core. Each module exposes its API through an `index.ts` of named re-exports, and lint rules will enforce these boundaries in CI.

## Considered Options

- **Group by purity (core/ and shell/)**: matches the functional core and imperative shell split, but a package split would cut across both groups.
- **Flat modules**: package membership would live only in lint rules and `package.json`.
- **Port types next to their user**: the Node filesystem adapter would then import from `dev/`, so a future adapter package would depend on the dev package.
- **A Hash port for the hash chain**: rejected for v0.1. `crypto.subtle.digest` behaves the same in Node, Deno, and Bun, so a small `sha256` helper wraps it. Randomness gets no such exemption and waits for its own port.

## Consequences

- Web Crypto digests are async, so verifying the hash chain is async.
