import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";

const FIXTURE = `import { defineTable } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

defineTable((c) => ({
  id: c.integer().default("1").identity(),
  tags: c.text().notNull().array(),
}));
`;

/** The message of each error tsc reports on `source`, without its file and position. */
async function typeErrors(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "column-errors-"));
  try {
    await writeFile(join(dir, "fixture.ts"), source);
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          typeRoots: [join(repo, "node_modules/@types")],
          types: ["node"],
        },
        files: ["fixture.ts"],
      }),
    );
    const { stdout } = spawnSync(join(repo, "node_modules/.bin/tsc"), ["--pretty", "false"], {
      cwd: dir,
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("fixture.ts("))
      .map((line) => line.replace(/^fixture\.ts\(\d+,\d+\): /u, ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Column type errors", () => {
  it("name each flag", async () => {
    expect(await typeErrors(FIXTURE)).toEqual([
      "error TS2339: Property 'identity' does not exist on type 'Column<number, { notNull: false; int: true; generated: true; primaryKey: false; key: false; codec: false; references: false; fresh: false; }>'.",
      "error TS2339: Property 'array' does not exist on type 'Column<string, { notNull: true; int: false; generated: false; primaryKey: false; key: false; codec: false; references: false; fresh: false; }>'.",
    ]);
  });
});
