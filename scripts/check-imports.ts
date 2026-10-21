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

export const importRules: IForbiddenRuleType[] = [
  {
    name: "runtime-stays-in-runtime",
    comment: "runtime/ imports nothing outside runtime/.",
    severity: "error",
    from: { path: "^src/runtime/" },
    to: { path: "^src/", pathNot: "^src/runtime/" },
  },
  {
    name: "runtime-no-npm",
    comment: "runtime/ imports no npm packages.",
    severity: "error",
    from: { path: "^src/runtime/" },
    to: { dependencyTypes: NPM },
  },
  {
    name: "adapter-imports-ports-only",
    comment:
      "An adapter imports only runtime/ports and its own files, never another adapter or dev/.",
    severity: "error",
    from: { path: "^src/adapters/([^/]+)/" },
    to: { path: "^src/", pathNot: ["^src/runtime/ports/", "^src/adapters/$1/"] },
  },
  {
    name: "postgres-js-adapter-host-package",
    comment: "adapters/postgres-js imports no npm package but postgres.",
    severity: "error",
    from: { path: "^src/adapters/postgres-js/" },
    to: { dependencyTypes: NPM, pathNot: "(^|/)node_modules/postgres/" },
  },
  {
    name: "adapter-no-npm",
    comment: "Other adapters import no npm packages.",
    severity: "error",
    from: { path: "^src/adapters/", pathNot: "^src/adapters/postgres-js/" },
    to: { dependencyTypes: NPM },
  },
  {
    name: "dev-no-adapters",
    comment: "dev/ never imports adapters/, except dev/cli, the Node composition root.",
    severity: "error",
    from: { path: "^src/dev/", pathNot: "^src/dev/cli/" },
    to: { path: "^src/adapters/" },
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
    comment: "An import from another module goes through that module's index.ts.",
    severity: "error",
    from: { path: "^src/([^/]+)/([^/]+)/" },
    to: { path: "^src/[^/]+/[^/]+/", pathNot: ["^src/$1/$2/", "^src/[^/]+/[^/]+/index\\.ts$"] },
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
    validate: true,
    ruleSet: { forbidden: importRules },
  });
  if (typeof output === "string") throw new Error("dependency-cruiser returned a formatted report");
  if (output.summary.totalCruised === 0) {
    return [{ from: "src", to: "src", rule: "scanned 0 modules" }];
  }
  return output.summary.violations.map(({ from, to, rule }) => ({ from, to, rule: rule.name }));
}

export async function main(baseDir = process.cwd()): Promise<void> {
  const problems = await checkImports(baseDir);
  for (const { from, to, rule } of problems) console.error(`${from} -> ${to}: ${rule}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
