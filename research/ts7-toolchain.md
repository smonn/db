# TypeScript 7 toolchain compatibility

Resolves smonn/db#12. Researched 2026-10-20.

## Answer

Every planned tool works with `typescript@7.0.2` installed as `typescript`, with one exception and one config fix.

- **dependency-cruiser needs a fallback.** It needs the TypeScript JS API, which 7.0 does not ship. With plain TS 7 it silently cruises 0 modules and exits 0. Use `parser: "swc"` today.
- **`#src/*.ts` imports fail type checking under `rewriteRelativeImportExtensions`** (TS2877). This is not a TS 7 regression: TS 6.0.3 does the same. Fix it in the repo config (see "Node 24 and `#` imports").
- tsdown, oxlint (type-aware), oxfmt, Vitest and knip all ran green on a sample project.

## Method

Sample project (not committed): Node 24.21.0, ESM, `typescript@7.0.2`, `.ts` import specifiers, `package.json` `imports` (`#src/*`), `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`. Each tool ran against it, with deliberate faults (floating promise, unused export, circular import, failing type test) to prove it was doing real work. Variants: `.js`-suffixed `#` imports, `rewriteRelativeImportExtensions` removed, and an npm-alias layout with `typescript` pointing at `@typescript/typescript6`.

## Background: what TS 7 changed

- TS 7.0 shipped 2026-07-08 as the Go-native compiler. It "does not ship with an API"; a "new (and different) API" is expected in 7.1. [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- `@typescript/typescript6` re-exports the TS 6.0 API and ships a `tsc6` binary so both can coexist. The post's layout aliases `typescript` to the TS 6 package and TS 7 under another name (`npm install -D typescript@npm:@typescript/typescript6`). Same post.
- Defaults changed: `strict` true, `types` defaults to `[]`, `baseUrl` and `moduleResolution: classic` removed. Same post. Our config sets what it needs explicitly (`types: ["node"]`).
- TS 7 declaration emit "differs greatly, intentionally" from 6.0. Type-check results match 6.0. [typescript-go README](https://github.com/microsoft/typescript-go)

## Per tool

| Tool | Version | Needs TS JS API? | Result with TS 7 | Fallback |
|---|---|---|---|---|
| tsdown | 0.23.1 (rolldown 1.2.14, rolldown-plugin-dts 0.28.8) | Only for the `tsc` dts generator | Works. `.d.mts` and `.mjs` built, `#src` imports bundled | `generator: 'oxc'` (isolated declarations) |
| oxlint | 1.89.0 + oxlint-tsgolint 7.0.2004 | No (typescript-go based) | Works. Type-aware rules and `--type-check` ran | None needed |
| oxfmt | 0.74.0 | No (Rust) | Works | None needed |
| Vitest | 5.0.5 | No (spawns the `tsc` binary) | Works. Unit, `expectTypeOf`, typecheck mode | None needed |
| knip | 6.42.1 | No (oxc-parser, oxc-resolver) | Works. Found unused files, exports, types, devDependencies | None needed |
| dependency-cruiser | 18.7.0 | Yes (`typescript` `>=2 <7`) | Broken: 0 modules, exit 0 | `parser: "swc"` or `@typescript/typescript6` |

### tsdown

- The dts generator is picked in rolldown-plugin-dts: `isolatedDeclarations` selects `oxc`; else TS 7.0 selects `tsgo`; else `tsc`. Forcing `generator: 'tsc'` under TS 7 throws "TypeScript 7.0 is not supported when using tsc". Verified by running all three. Source: [`rolldown-plugin-dts` v0.28.8 dist](https://www.npmjs.com/package/rolldown-plugin-dts/v/0.28.8) (`require-BbBF8Ii0.mjs`, `index.mjs`).
- The default run printed `WARN TypeScript 7.0 does not yet have a stable API and is experimental` and `Emit types with typescript@7.0.2`. The warning breaks `failOnWarn: true`; the fix is `suppressWarnings: ['does not yet have a stable API']` ([tsdown#1013](https://github.com/rolldown/tsdown/issues/1013), fixed upstream; not exercised here).
- tsdown peer range is `typescript ^5 || ^6 || ^7` (0.23.1 manifest). Older advice to keep `typescript` on TS 6 ([tsdown#978](https://github.com/rolldown/tsdown/issues/978), [tsdown#996](https://github.com/rolldown/tsdown/issues/996)) predates this and is out of date for 0.23.1 + plugin 0.28.8.
- tsdown 0.23 renamed dts options (`dts.oxc: true` becomes `dts.generator: 'oxc'`). [v0.23.0 notes](https://github.com/rolldown/tsdown/releases/tag/v0.23.0)
- With `generator: 'oxc'`, tsdown requires isolated-declarations-clean exports. The sample was trivially clean; a real codebase needs explicit return types on every export. Not tested at scale.
- The `tsgo` (TS 7) and `tsc` (TS 6, alias layout) builds produced the same size `.d.mts` for the sample (0.38 kB); I did not diff the content. Declaration emit "differs greatly" in TS 7 per the README, so recheck on a real API surface, especially generics and inferred types.
- Not tested: publishing, `attw`, `publint`, dual CJS output (we are ESM-only).

### oxlint

- Docs: type-aware linting needs `oxlint-tsgolint`, requires "TypeScript 7.0+", and `options.typeAware` / `options.typeCheck` work only in the root config. It covers 59 of 61 typescript-eslint type-aware rules. [Type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- Verified: `no-floating-promises` and `no-unnecessary-condition` fired. `typeCheck: true` reported TS diagnostics (TS2877) from the oxlint run itself. It gave the same results with `typescript` aliased to TS 6, so tsgolint is self-contained.
- oxlint 1.89.0 declares peer `oxlint-tsgolint >=7.0.2003`.
- Untested: the two uncovered rules, large-repo memory use (docs flag it).

### oxfmt

- Rust, no dependency on `typescript`. Formatted TS with `#` imports correctly. No TS 7 interaction. [Formatter docs](https://oxc.rs/docs/guide/usage/formatter.html)

### Vitest

- Docs: "Under the hood Vitest calls `tsc` or `vue-tsc`" for type tests. [Testing types](https://vitest.dev/guide/testing-types.html) With TS 7 installed, `tsc` is the native binary and it works.
- Verified: unit tests, `expectTypeOf` in `.test-d.ts` under `typecheck.enabled`, and a deliberate failing type test (reported as a failed test with the right message). Vitest 5.0.5 prints "Testing types with tsc and vue-tsc is an experimental feature".
- Vitest also reports TS2877 from the `#` imports (see below).
- The Vitest bundle has no `import 'typescript'`; type tests only shell out to the `tsc` binary.

### knip

- Knip 6 replaced the TypeScript backend with `oxc-parser` and `oxc-resolver`. [Knip v6](https://knip.dev/blog/knip-v6) Its 6.42.1 manifest lists `typescript` only as a devDependency.
- Verified: unused files, unused exports, unused exported types, and unused devDependencies, with imports followed through `#src/*`.
- `--include cycles` returned nothing on the sample's unreachable cycle. I did not test it on a reachable cycle, so do not treat it as a dependency-cruiser replacement without testing.

### dependency-cruiser

- 18.7.0 supports `typescript >=2 <7`. Its own message: "Support for typescript@>=7 will follow when its API is published and stable." With TS 7 it printed `missing-typescript-transpiler` and reported "0 modules, 0 dependencies cruised" with exit 0. A CI job would pass while checking nothing. Guard against it (see recommendation).
- Maintainer position: no TS 7 support until the 7.1 API; a `@typescript/typescript6` mode is being built, and `swc` is the interim path. [dependency-cruiser#1112](https://github.com/sverweij/dependency-cruiser/issues/1112), [#1069](https://github.com/sverweij/dependency-cruiser/issues/1069)
- Verified `parser: "swc"` (with `@swc/core` 1.16.18): 9 modules, `#src` and `./x.ts` imports resolved, type-only edges kept, a deliberate circular import reported as `no-circular` (exit 1).
- Verified alias layout (`typescript` = `@typescript/typescript6` 6.0.2, TS 7 as `@typescript/native`): the default `tsc` parser worked, the circular import was caught, and `tsc` (7.0.2) and `tsc6` both exist. Type-only imports were dropped unless `tsPreCompilationDeps` is on (not tested).
- swc limits: `tsPreCompilationDeps` has no effect, no JSDoc dependencies, and it can fail on `.d.ts` files. [dependency-cruiser#1104](https://github.com/sverweij/dependency-cruiser/issues/1104), [#1112](https://github.com/sverweij/dependency-cruiser/issues/1112)

## Node 24 and `#` imports

- Node 24.12.0 made type stripping stable; 24.3.0 dropped the warning. Imports need the `.ts` extension, `tsconfig` `paths` are ignored, and `#` subpath imports are "the closest feature available". Node refuses `.ts` files under `node_modules`, so the published package must ship the tsdown JS. [Node 24 TypeScript docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- Verified on Node 24.21.0: `node src/index.ts` runs with both `import '#src/greet.ts'` and `import '#src/greet.js'` (imports map `"#src/*.js": "./src/*.ts"`). With `--no-experimental-strip-types` it fails with `ERR_UNKNOWN_FILE_EXTENSION`, so stripping is what runs it.
- Subpath patterns are literal string substitution with no extension handling, so mapping `*.js` to `*.ts` is legal. [Node packages docs](https://nodejs.org/docs/latest-v24.x/api/packages.html#subpath-imports)

### Does `rewriteRelativeImportExtensions` apply to `#` imports?

No. TS rewrites only relative paths; the TS 5.7 notes list `"#/file.ts"` and `"some-package/file.ts"` as not rewritten. [TS 5.7](https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/) With the flag on, a `.ts` specifier on a non-relative import is an error:

```
error TS2877: This import uses a '.ts' extension to resolve to an input TypeScript file,
but will not be rewritten during emit because it is not a relative path.
```

Reproduced with `tsc` 7.0.2 and `tsc6` 6.0.3, and it surfaces through oxlint `typeCheck` and Vitest typecheck too. Because tsdown bundles, the missing rewrite would not matter at runtime; only the checker objects.

Two fixes, both verified (tsc, oxlint, vitest, tsdown, knip, node 24; dependency-cruiser with swc for the first):

1. Write `#` imports with `.js` and map them to `.ts`: `"imports": { "#src/*.js": "./src/*.ts" }`, `import ... from '#src/greet.js'`. Keep `rewriteRelativeImportExtensions`. Cost: relative imports use `.ts`, `#` imports use `.js`.
2. Drop `rewriteRelativeImportExtensions` from the repo tsconfig, keep `#src/*.ts`. `tsc` is `noEmit` and tsdown does the emit, so the flag does nothing here. Node's recommended tsconfig lists it for projects that emit with `tsc`. Verified with `tsc`, oxlint, Vitest and tsdown; not with knip or dependency-cruiser.

## Recommendation

- Install `typescript@7.0.2` as plain `typescript`. Let tsdown pick `tsgo`, or enable `isolatedDeclarations` and pin `generator: 'oxc'` for speed. Decide after a real API surface exists.
- Pick fix 2 unless the repo emits with `tsc` somewhere. It keeps one import style. Pick fix 1 if it does.
- dependency-cruiser: use `parser: "swc"` plus `@swc/core` now. Add a CI guard that fails when the cruised module count is 0 (e.g. parse `--output-type json` `summary.totalCruised`). Revisit when it ships `@typescript/typescript6` support or TS 7.1 ships an API.
- If swc proves too lossy, the alias layout works (`typescript` = `@typescript/typescript6`, TS 7 as `@typescript/native`, `tsc` from the native package). Cost: every tool that reads `typescript` sees TS 6, so tsdown then uses its `tsc` generator.
- Rejected: pinning everything to TS 6. It buys nothing the alias layout does not, and gives up the native checker.

## Unverified

- tsdown and oxc generators on a real public API; `failOnWarn` + `suppressWarnings`; publint/attw.
- knip cycle detection on a reachable cycle; oxlint `import/no-cycle` as a dependency-cruiser stand-in.
- dependency-cruiser's unreleased `@typescript/typescript6` mode (reported by the maintainer, not seen).
- Windows/Linux behavior (ran on macOS arm64 only).
- Version numbers are `npm view` `latest` on 2026-10-20 and will drift.
