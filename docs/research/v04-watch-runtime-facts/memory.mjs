/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node --expose-gc memory.mjs <modules> <reloads>
// Reloads a fixture of <modules> TypeScript files (an entry plus a chain of imports, ~3 KB each) <reloads> times through a
// resolve hook that versions every project file URL, and reports heap, RSS, and the time per reload after GC.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { versionProjectImports } from "./version-imports.mjs";

const modules = Number(process.argv[2] ?? 20);
const reloads = Number(process.argv[3] ?? 500);
const dir = join(tmpdir(), `memory-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const filler = Array.from(
  { length: 40 },
  (_, i) => `  c${i}: { type: "text", nullable: ${i % 2 === 0}, default: "value ${i}" },`,
).join("\n");
for (let i = 0; i < modules; i++) {
  const next = i + 1 < modules ? `import { t${i + 1} } from "./m${i + 1}.ts";\n` : "";
  const child = i + 1 < modules ? `, next: t${i + 1}` : "";
  writeFileSync(
    join(dir, `m${i}.ts`),
    `${next}export const t${i}: { readonly cols: Record<string, unknown>; readonly next?: unknown } = {\n  cols: {\n${filler}\n  }${child},\n};\n`,
  );
}

let generation = 0;
versionProjectImports(() => generation);

const mb = (n) => (n / 1024 / 1024).toFixed(1);
function sample(label) {
  globalThis.gc();
  globalThis.gc();
  const m = process.memoryUsage();
  console.log(`${label}: heapUsed ${mb(m.heapUsed)} MB, rss ${mb(m.rss)} MB`);
}
sample("baseline");
const started = performance.now();
for (let g = 0; g < reloads; g++) {
  generation = g;
  const mod = await import(pathToFileURL(join(dir, "m0.ts")).href);
  void mod;
  if ((g + 1) % Math.max(1, Math.floor(reloads / 4)) === 0)
    sample(`after ${g + 1} reloads (${(g + 1) * modules} module instances)`);
}
console.log(
  `${process.version}: ${((performance.now() - started) / reloads).toFixed(2)} ms per reload of ${modules} modules`,
);
rmSync(dir, { recursive: true, force: true });
