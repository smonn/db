/**
 * Enforces the import rules between `src/` modules with dependency-cruiser and exits 1 on any
 * violation. Also exits 1 when it scans no modules, so a broken parser or path can't pass silently.
 *
 * Run from the repo root with `pnpm check:imports`; CI runs it in the Lint job.
 */
import { realpathSync } from "node:fs";
import { cruise } from "dependency-cruiser";
import type { DependencyType, IForbiddenRuleType } from "dependency-cruiser";

export type Problem = {
  from: string;
  to: string;
  rule: string;
};

const NPM: DependencyType[] = [
  "npm",
  "npm-dev",
  "npm-optional",
  "npm-peer",
  "npm-bundled",
  "npm-no-pkg",
  "npm-unknown",
];
const TEST_ONLY = String.raw`\.test(-helper)?\.ts$`;
const VITEST = "(^|/)node_modules/vitest/";
// Integration tests in every group need a real database. no-test-imports keeps it out of non-test code.
const TEST_DATABASE = String.raw`^src/adapters/postgres-js/test-database\.test-helper\.ts$`;

export const importRules: IForbiddenRuleType[] = [
  {
    name: "runtime-stays-in-runtime",
    comment: "runtime/ imports nothing outside runtime/ but the test database helper.",
    severity: "error",
    from: { path: "^src/runtime/" },
    to: { path: "^src/", pathNot: ["^src/runtime/", TEST_DATABASE] },
  },
  {
    name: "runtime-no-npm",
    comment: "runtime/ imports no npm packages.",
    severity: "error",
    from: { path: "^src/runtime/" },
    to: { dependencyTypes: NPM, pathNot: VITEST },
  },
  {
    name: "adapter-imports-ports-or-internal",
    comment:
      "An adapter imports only runtime/ports, runtime/internal, its own files, and the test database helper, never another adapter or dev/.",
    severity: "error",
    from: { path: "^src/adapters/([^/]+)/" },
    to: {
      path: "^src/",
      pathNot: ["^src/runtime/(ports|internal)/", "^src/adapters/$1/", TEST_DATABASE],
    },
  },
  {
    name: "postgres-js-adapter-host-package",
    comment: "adapters/postgres-js imports no npm package but postgres.",
    severity: "error",
    from: { path: "^src/adapters/postgres-js/" },
    to: { dependencyTypes: NPM, pathNot: ["(^|/)node_modules/postgres/", VITEST] },
  },
  {
    name: "adapter-no-npm",
    comment: "Other adapters import no npm packages.",
    severity: "error",
    from: { path: "^src/adapters/", pathNot: "^src/adapters/postgres-js/" },
    to: { dependencyTypes: NPM, pathNot: VITEST },
  },
  {
    name: "dev-no-adapters",
    comment:
      "dev/ never imports adapters/, except dev/cli, the Node composition root, and the test database helper.",
    severity: "error",
    from: { path: "^src/dev/", pathNot: "^src/dev/cli/" },
    to: { path: "^src/adapters/", pathNot: TEST_DATABASE },
  },
  {
    name: "node-builtins-in-host-code",
    comment: "node:* imports appear only in adapters/ and dev/cli.",
    severity: "error",
    from: { path: "^src/", pathNot: "^src/(adapters|dev/cli)/" },
    to: { dependencyTypes: ["core"] },
  },
  {
    name: "cross-module-through-index",
    comment:
      "An import from another module goes through that module's index.ts, except the test database helper.",
    severity: "error",
    from: { path: "^src/([^/]+)/([^/]+)/" },
    to: {
      path: "^src/[^/]+/[^/]+/",
      pathNot: ["^src/$1/$2/", "^src/[^/]+/[^/]+/index\\.ts$", TEST_DATABASE],
    },
  },
  {
    name: "internal-not-reexported",
    comment:
      "runtime/internal holds shared helpers, never public API, so no other module's index.ts imports it.",
    severity: "error",
    from: { path: String.raw`(^|/)index\.ts$`, pathNot: "^src/runtime/internal/" },
    to: { path: "^src/runtime/internal/" },
  },
  {
    name: "no-cycles",
    comment: "No import cycles.",
    severity: "error",
    from: {},
    to: { circular: true },
  },
  {
    name: "no-test-imports",
    comment: "Non-test code never imports *.test.ts files or *.test-helper.ts helpers.",
    severity: "error",
    from: { pathNot: TEST_ONLY },
    to: { path: TEST_ONLY },
  },
  {
    name: "vitest-in-tests-only",
    comment: "Only tests and test helpers import vitest, which the npm rules above let through.",
    severity: "error",
    from: { pathNot: TEST_ONLY },
    to: { path: VITEST },
  },
  {
    name: "no-unresolvable",
    comment: "Every import resolves, so a typo can't slip past the rules above.",
    severity: "error",
    from: {},
    to: { couldNotResolve: true },
  },
];

export async function checkImports(baseDir: string): Promise<Problem[]> {
  const { output } = await cruise(["src"], {
    // Through a symlinked baseDir, such as macOS's /var, resolved paths leave src/ and match no rule.
    baseDir: realpathSync(baseDir),
    parser: "swc",
    // Rules judge only src/'s own imports, so the cruise stops at a package's entry.
    doNotFollow: { path: "node_modules" },
    validate: true,
    ruleSet: { forbidden: importRules },
  });
  if (typeof output === "string") throw new Error("dependency-cruiser returned a formatted report");
  if (output.summary.totalCruised === 0) {
    return [{ from: "src", to: "src", rule: "scanned 0 modules" }];
  }
  return output.summary.violations.map(({ from, to, rule }) => ({ from, to, rule: rule.name }));
}

export async function main(baseDir: string = process.cwd()): Promise<void> {
  const problems = await checkImports(baseDir);
  for (const { from, to, rule } of problems) console.error(`${from} -> ${to}: ${rule}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
