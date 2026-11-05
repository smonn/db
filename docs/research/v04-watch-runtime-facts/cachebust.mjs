/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node cachebust.mjs <plain|query|hook>
// Edits a fixture's entry and a transitive import between loads, and reports which edit each strategy sees.
// The fixture is erasable TypeScript with `.ts` relative imports and `import type`, as ADR-0014 loads it.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { versionProjectImports } from "./version-imports.mjs";

const mode = process.argv[2] ?? "query";
const dir = join(tmpdir(), `cachebust-${mode}-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "tables"), { recursive: true });

function write(entryV, leafV) {
  writeFileSync(
    join(dir, "tables", "users.ts"),
    `export type Leaf = { readonly v: number };\nexport const users: Leaf = { v: ${leafV} };\n`,
  );
  writeFileSync(
    join(dir, "definition.ts"),
    `import type { Leaf } from "./tables/users.ts";\nimport { users } from "./tables/users.ts";\nexport const entry: number = ${entryV};\nexport default { entry, leaf: (users satisfies Leaf).v };\n`,
  );
}

let generation = 0;
if (mode === "hook") versionProjectImports(() => generation);

async function load() {
  const base = pathToFileURL(join(dir, "definition.ts")).href;
  const url = mode === "plain" ? base : mode === "query" ? `${base}?v=${generation}` : base;
  return (await import(url)).default;
}

write(1, 1);
console.log(process.version, mode, "load 1:", JSON.stringify(await load()));
generation++;
write(2, 1);
console.log(
  process.version,
  mode,
  "after editing the entry (entry=2):",
  JSON.stringify(await load()),
);
generation++;
write(2, 3);
console.log(
  process.version,
  mode,
  "after editing the leaf import (leaf=3):",
  JSON.stringify(await load()),
);
rmSync(dir, { recursive: true, force: true });
