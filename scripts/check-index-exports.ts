/**
 * Checks that every `src/**\/index.ts` holds only named re-exports, such as
 * `export { a } from "./a.ts"`: no declarations, no imports, no `export *`, and no default
 * re-export. Also checks each group index (`src/runtime/index.ts`, `src/dev/index.ts`), which
 * lists the package's public API by hand: it exists, and it re-exports only names its modules'
 * `index.ts` files export in the same form (a value as a value, a type as a type), outside the
 * modules `GROUPS` leaves out.
 * Prints `file: problem` and exits 1 on any problem.
 *
 * Run from the repo root with `pnpm check:index`; CI runs it in the Lint job.
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "@swc/core";

/** Each group index, as a package entry point, and the modules it leaves out as not public API. */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  runtime: ["internal"],
  dev: ["cli"],
};

export function checkIndexExports(text: string): string[] {
  return parseSync(text, { syntax: "typescript" }).body.flatMap((item) => {
    if (item.type === "ExportAllDeclaration")
      return ["`export *` hides the module's API; name each re-export"];
    if (
      item.type !== "ExportNamedDeclaration" ||
      item.source === undefined ||
      item.source === null
    ) {
      return [`${item.type} is not a named re-export`];
    }
    return item.specifiers.flatMap((specifier) => {
      if (specifier.type !== "ExportSpecifier")
        return [`${specifier.type} is not a named re-export`];
      const name = (specifier.exported ?? specifier.orig).value;
      return name === "default" ? ["re-exporting a default is not a named re-export"] : [];
    });
  });
}

/** Each name an index re-exports, prefixed `type ` when it re-exports only the type. */
export function exportedNames(text: string): string[] {
  return parseSync(text, { syntax: "typescript" }).body.flatMap((item) => {
    if (item.type !== "ExportNamedDeclaration") return [];
    return item.specifiers.flatMap((specifier) => {
      if (specifier.type !== "ExportSpecifier") return [];
      const name = (specifier.exported ?? specifier.orig).value;
      return [item.typeOnly || specifier.isTypeOnly ? `type ${name}` : name];
    });
  });
}

/** Names each group index export that no module's index exports in the same form. */
export function checkGroupIndex(group: readonly string[], modules: readonly string[]): string[] {
  const exported = new Set(modules);
  return group
    .filter((name) => !exported.has(name))
    .map((name) => `exports ${name}, which no module's index.ts exports`);
}

function groupProblems(cwd: string): string[] {
  return Object.entries(GROUPS).flatMap(([group, excluded]) => {
    const file = `src/${group}/index.ts`;
    if (!existsSync(join(cwd, file))) return [`${file}: is missing`];
    const modules = globSync(`src/${group}/*/index.ts`, { cwd }).filter(
      (path) => !excluded.includes(path.split("/")[2] ?? ""),
    );
    const names = (path: string): string[] => exportedNames(readFileSync(join(cwd, path), "utf8"));
    return checkGroupIndex(
      names(file),
      modules.flatMap((path) => names(path)),
    ).map((p) => `${file}: ${p}`);
  });
}

export function main(cwd: string = process.cwd()): void {
  const problems: string[] = [];
  for (const file of globSync("src/**/index.ts", { cwd }).toSorted()) {
    for (const problem of checkIndexExports(readFileSync(join(cwd, file), "utf8"))) {
      problems.push(`${file}: ${problem}`);
    }
  }
  problems.push(...groupProblems(cwd));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
