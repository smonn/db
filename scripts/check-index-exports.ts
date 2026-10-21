/**
 * Checks that every `src/**\/index.ts` holds only named re-exports, such as
 * `export { a } from "./a.ts"`: no declarations, no imports, no `export *`, and no default
 * re-export. Prints `file: problem` and exits 1 on any problem.
 *
 * Run from the repo root with `pnpm check:index`; CI runs it in the Lint job.
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "@swc/core";

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

export function main(cwd: string = process.cwd()): void {
  let failed = false;
  for (const file of globSync("src/**/index.ts", { cwd }).toSorted()) {
    for (const problem of checkIndexExports(readFileSync(join(cwd, file), "utf8"))) {
      console.error(`${file}: ${problem}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) main();
