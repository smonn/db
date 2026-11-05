/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node fswatch.mjs [dir]
// Runs editor-style writes under a recursive fs.watch and prints the events each one produced.
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = mkdtempSync(join(process.argv[2] ?? tmpdir(), "fswatch-"));
mkdirSync(join(root, "src", "tables"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(root, "src", "tables", "b.ts"), "export const b = 1;\n");
writeFileSync(join(root, "current.sql"), "-- 1\n");
await sleep(300);

let events = [];
const watcher = watch(root, { recursive: true }, (type, name) => events.push(`${type}:${name}`));
watcher.on("error", (e) => console.log("watcher error", e.message));
await sleep(300);

async function scenario(label, fn, settle = 400) {
  events = [];
  await fn();
  await sleep(settle);
  console.log(`${label}\n    ${events.length} events: ${events.join(" | ") || "(none)"}`);
}

console.log(process.platform, process.version, "recursive watch of", root);
await scenario("in-place write (writeFileSync, truncate+write)", () =>
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n"),
);
await scenario("append", () => appendFileSync(join(root, "src", "a.ts"), "// x\n"));
await scenario("touch (utimes only)", () =>
  utimesSync(join(root, "src", "a.ts"), new Date(), new Date()),
);
await scenario(
  "atomic save: write a.ts.tmp then rename over a.ts (JetBrains safe write, many formatters)",
  () => {
    writeFileSync(join(root, "src", "a.ts.tmp"), "export const a = 3;\n");
    renameSync(join(root, "src", "a.ts.tmp"), join(root, "src", "a.ts"));
  },
);
await scenario("vim-style: rename a.ts to a.ts~, write new a.ts, delete a.ts~", () => {
  renameSync(join(root, "src", "a.ts"), join(root, "src", "a.ts~"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 4;\n");
  unlinkSync(join(root, "src", "a.ts~"));
});
await scenario("create file in a nested dir", () =>
  writeFileSync(join(root, "src", "tables", "c.ts"), "export const c = 1;\n"),
);
await scenario("delete file", () => unlinkSync(join(root, "src", "tables", "c.ts")));
await scenario("create new directory and a file in it at once", () => {
  mkdirSync(join(root, "src", "newdir"));
  writeFileSync(join(root, "src", "newdir", "d.ts"), "export const d = 1;\n");
});
await sleep(300);
await scenario("edit that new directory's file afterwards", () =>
  writeFileSync(join(root, "src", "newdir", "d.ts"), "export const d = 2;\n"),
);
await scenario("move a dir tree in from outside (git checkout / pull style)", () => {
  const outside = mkdtempSync(join(tmpdir(), "fswatch-outside-"));
  mkdirSync(join(outside, "tree"));
  writeFileSync(join(outside, "tree", "e.ts"), "export const e = 1;\n");
  renameSync(join(outside, "tree"), join(root, "src", "tree"));
  rmSync(outside, { recursive: true });
});
await sleep(300);
await scenario("edit a file inside the moved-in tree", () =>
  writeFileSync(join(root, "src", "tree", "e.ts"), "export const e = 2;\n"),
);
await scenario(
  "burst: 50 files rewritten in a row",
  () => {
    for (let i = 0; i < 50; i++)
      writeFileSync(join(root, "src", `burst${i}.ts`), `export const n = ${i};\n`);
  },
  700,
);
await scenario("copyFileSync over an existing file", () =>
  copyFileSync(join(root, "src", "a.ts"), join(root, "src", "tables", "b.ts")),
);
await scenario("rm -r a watched subdirectory", () =>
  rmSync(join(root, "src", "newdir"), { recursive: true }),
);
await scenario("recreate that directory and write into it", () => {
  mkdirSync(join(root, "src", "newdir"));
  writeFileSync(join(root, "src", "newdir", "d.ts"), "export const d = 9;\n");
});
await sleep(300);
await scenario("edit inside the recreated directory", () =>
  writeFileSync(join(root, "src", "newdir", "d.ts"), "export const d = 10;\n"),
);
watcher.close();

// A watcher on a single file, then two atomic saves.
let single = [];
const fileWatcher = watch(join(root, "current.sql"), (type, name) =>
  single.push(`${type}:${name}`),
);
await sleep(200);
writeFileSync(join(root, "current.sql.tmp"), "-- 2\n");
renameSync(join(root, "current.sql.tmp"), join(root, "current.sql"));
await sleep(400);
const afterFirst = single.length;
writeFileSync(join(root, "current.sql.tmp"), "-- 3\n");
renameSync(join(root, "current.sql.tmp"), join(root, "current.sql"));
await sleep(400);
console.log(
  `single-file watch, 2 atomic saves: ${afterFirst} events after the first save, ${single.length - afterFirst} after the second (${single.join(" | ")})`,
);
fileWatcher.close();

// The ignore option, which the fs docs list without a version.
let ignored = [];
const ignoreWatcher = watch(
  root,
  { recursive: true, ignore: ["**/node_modules/**", "**/*.tmp"] },
  (type, name) => ignored.push(`${type}:${name}`),
);
await sleep(200);
mkdirSync(join(root, "node_modules"), { recursive: true });
writeFileSync(join(root, "node_modules", "x.js"), "1");
writeFileSync(join(root, "src", "z.tmp"), "1");
writeFileSync(join(root, "src", "z.ts"), "1");
await sleep(400);
console.log(`ignore option: ${ignored.join(" | ") || "(none)"}`);
ignoreWatcher.close();
rmSync(root, { recursive: true, force: true });
