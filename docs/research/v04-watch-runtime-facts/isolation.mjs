/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node --expose-gc isolation.mjs <worker|child> <modules> <runs>
// Loads the memory.mjs fixture in a fresh Worker or child process per run, with TypeScript entry points (type stripping),
// and reports time per run and the parent's heap and RSS afterwards.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const mode = process.argv[2] ?? "worker";
const modules = Number(process.argv[3] ?? 20);
const runs = Number(process.argv[4] ?? 100);
const dir = join(tmpdir(), `isolation-${mode}-${process.pid}`);
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
// Both entries are .ts files: the Worker and the child process must strip types themselves.
const entry = pathToFileURL(join(dir, "m0.ts")).href;
writeFileSync(
  join(dir, "worker.ts"),
  `import { parentPort, workerData } from "node:worker_threads";\nconst mod: { t0: { cols: Record<string, unknown> } } = await import(workerData.entry);\nparentPort!.postMessage({ columns: Object.keys(mod.t0.cols).length });\n`,
);
writeFileSync(
  join(dir, "child.ts"),
  `const mod: { t0: { cols: Record<string, unknown> } } = await import(process.argv[2]!);\nconsole.log(JSON.stringify({ columns: Object.keys(mod.t0.cols).length }));\n`,
);

const exec = promisify(execFile);
function runWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(dir, "worker.ts"), { workerData: { entry } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
async function runChild() {
  const { stdout } = await exec(process.execPath, [join(dir, "child.ts"), entry]);
  return JSON.parse(stdout);
}
const run = mode === "worker" ? runWorker : runChild;

const mb = (n) => (n / 1024 / 1024).toFixed(1);
function sample(label) {
  globalThis.gc();
  const m = process.memoryUsage();
  console.log(`${label}: parent heapUsed ${mb(m.heapUsed)} MB, rss ${mb(m.rss)} MB`);
}
sample("baseline");
console.log("first result:", JSON.stringify(await run()));
const started = performance.now();
for (let i = 0; i < runs; i++) {
  await run();
  if ((i + 1) % Math.max(1, Math.floor(runs / 4)) === 0) sample(`after ${i + 1} runs`);
}
console.log(
  `${process.version} ${mode}: ${((performance.now() - started) / runs).toFixed(1)} ms per run of ${modules} modules`,
);
rmSync(dir, { recursive: true, force: true });
