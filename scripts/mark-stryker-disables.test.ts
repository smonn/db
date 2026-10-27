import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main, mutatedFiles } from "./mark-stryker-disables.ts";

const disabled = "// Stryker disable next-line StringLiteral: never shown\nf('x');\n";
const marked = "// Stryker expect next-line StringLiteral: never shown\nf('x');\n";

let dir: string;
const write = (file: string, text: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const read = (file: string): string => readFileSync(join(dir, file), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mark-stryker-disables-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("the Mutation workflow marks the disables right before it runs Stryker", () => {
  expect(readFileSync(".github/workflows/mutation.yml", "utf8")).toContain(
    "- run: pnpm mutation:mark\n      - run: pnpm mutation\n",
  );
});

test("lists the files the globs name, less the excluded ones, sorted", () => {
  for (const file of ["src/b.ts", "src/a.ts", "src/a.test.ts", "c.ts", "docs/d.md"])
    write(file, "");
  expect(mutatedFiles(["**/*.ts", "!**/*.test.ts"], dir)).toEqual(["c.ts", "src/a.ts", "src/b.ts"]);
});

test("marks the disables in the shard's mutated files only", () => {
  write("scripts/a.ts", disabled);
  write("scripts/a.test.ts", disabled);
  write("src/runtime/b.ts", disabled);
  write("scripts/clean.ts", "f();\n");
  main({ MUTATION_SHARD: "scripts" }, dir);
  expect(read("scripts/a.ts")).toBe(marked);
  expect(read("scripts/a.test.ts")).toBe(disabled);
  expect(read("src/runtime/b.ts")).toBe(disabled);
  expect(read("scripts/clean.ts")).toBe("f();\n");
  expect(console.log).toHaveBeenCalledWith("Marked the Stryker disable comments in 1 files");
  expect(console.log).toHaveBeenCalledWith("  scripts/a.ts");
});
