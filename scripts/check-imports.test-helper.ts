import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkImports } from "./check-imports.ts";

const dirs: string[] = [];

export function removeRepos(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-imports-"));
  dirs.push(dir);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { postgres: "*", "left-pad": "*" },
      devDependencies: { vitest: "*" },
    }),
    "node_modules/postgres/package.json": JSON.stringify({ name: "postgres", main: "index.js" }),
    "node_modules/postgres/index.js": "export default 1;",
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
    "node_modules/left-pad/index.js": "export default 1;",
    "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", main: "index.js" }),
    // An unresolvable import inside a package shows whether the cruise follows into node_modules.
    "node_modules/vitest/index.js": 'import "not-installed";\nexport const test = 1;',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

export async function rulesBroken(files: Record<string, string>): Promise<string[]> {
  const problems = await checkImports(repo(files));
  return problems.map(({ rule }) => rule);
}
