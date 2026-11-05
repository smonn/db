/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node errorcache.mjs <query|hook>
// A transitive import with a syntax error, then fixed: does the next load recover?
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { versionProjectImports } from "./version-imports.mjs";

const mode = process.argv[2] ?? "query";
const dir = join(tmpdir(), `errorcache-${mode}-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let generation = 0;
if (mode === "hook") versionProjectImports(() => generation);
writeFileSync(
  join(dir, "definition.ts"),
  `import { leaf } from "./leaf.ts";\nexport default { leaf };\n`,
);
async function load(label) {
  const base = pathToFileURL(join(dir, "definition.ts")).href;
  try {
    console.log(
      process.version,
      mode,
      label,
      "->",
      JSON.stringify((await import(mode === "query" ? `${base}?v=${generation}` : base)).default),
    );
  } catch (error) {
    console.log(
      process.version,
      mode,
      label,
      "-> FAIL",
      error.constructor.name,
      String(error.message).split("\n")[0],
    );
  }
}
writeFileSync(join(dir, "leaf.ts"), `export const leaf: number = ;\n`);
await load("leaf has a syntax error");
generation++;
writeFileSync(join(dir, "leaf.ts"), `export const leaf: number = 1;\n`);
await load("leaf fixed");
generation++;
writeFileSync(
  join(dir, "leaf.ts"),
  `export const leaf: number = 1;\nthrow new Error("boom at evaluation");\n`,
);
await load("leaf throws when evaluated");
generation++;
writeFileSync(join(dir, "leaf.ts"), `export const leaf: number = 2;\n`);
await load("leaf fixed again");
rmSync(dir, { recursive: true, force: true });
