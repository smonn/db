---
status: proposed
---

# Relative `.ts` imports, with tsdown as the only emitter

Source files import each other with relative paths that end in `.ts`, such as `./driver.ts`, and tsdown emits all JavaScript while `tsc` only type-checks (`noEmit`, `allowImportingTsExtensions`). `#src/*` subpath imports were meant to avoid deep `../` chains, but the tree is shallow, and every tool would then have to resolve the mapping. Plain relative imports need no extra config, as in Kysely.

## Considered Options

- **`#src/*.ts` subpath imports with `rewriteRelativeImportExtensions` dropped**: the flag only rewrites relative paths, so with it on `#src/x.ts` fails type checking (TS2877). Dropping it fixes that, but knip, dependency-cruiser, and Vitest still resolve the mapping.
- **`#src/*.js` mapped to `./src/*.ts`, keeping `rewriteRelativeImportExtensions`**: works, but `#src` imports end in `.js` while relative imports end in `.ts`.
- **tsconfig `paths`, as Drizzle does with `~/`**: Node's type stripping ignores `paths`, so `scripts/` and the config file could not run directly.

## Consequences

- The published package holds only tsdown's bundled output, with no `.ts` specifiers.
- `rewriteRelativeImportExtensions` is not set, because `tsc` emits nothing.
