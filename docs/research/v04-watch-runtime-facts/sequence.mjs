/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Usage: node sequence.mjs [dir]
// Does a recursive watcher keep seeing a file after it was replaced by rename (editor safe-write)?
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = mkdtempSync(join(process.argv[2] ?? tmpdir(), "sequence-"));
mkdirSync(join(root, "src"), { recursive: true });
const file = join(root, "src", "a.ts");
writeFileSync(file, "0");
await sleep(200);
let events = [];
// WATCH=dir watches the file's parent directory without `recursive`; the default is one recursive watch of the root.
const watcher =
  process.env.WATCH === "dir"
    ? watch(join(root, "src"), (type, name) => events.push(`${type}:${name}`))
    : watch(root, { recursive: true }, (type, name) => events.push(`${type}:${name}`));
await sleep(200);
async function step(label, fn) {
  events = [];
  fn();
  await sleep(300);
  console.log(`${label.padEnd(58)} ${events.length} event(s) ${events.join(" ")}`);
}
console.log(process.platform, process.version);
await step("1 in-place write", () => writeFileSync(file, "1"));
await step("2 safe-write (tmp + rename over)", () => {
  writeFileSync(file + ".tmp", "2");
  renameSync(file + ".tmp", file);
});
await step("3 in-place write after the safe-write", () => writeFileSync(file, "3"));
await step("4 safe-write again", () => {
  writeFileSync(file + ".tmp", "4");
  renameSync(file + ".tmp", file);
});
await step("5 in-place write after the second safe-write", () => writeFileSync(file, "5"));
await step("6 vim-style (a.ts -> a.ts~, new a.ts, rm a.ts~)", () => {
  renameSync(file, file + "~");
  writeFileSync(file, "6");
  unlinkSync(file + "~");
});
await step("7 in-place write after vim-style", () => writeFileSync(file, "7"));
await step("8 delete then recreate a.ts (git checkout of another branch)", () => {
  unlinkSync(file);
  writeFileSync(file, "8");
});
await step("9 in-place write after delete+recreate", () => writeFileSync(file, "9"));
watcher.close();
rmSync(root, { recursive: true, force: true });
