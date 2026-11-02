import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./packed-package.test-helper.ts";

/** The message of each error tsc reports on `source`, without its file and position. */
export async function typeErrors(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "type-errors-"));
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
    const { stdout, error } = spawnSync(
      join(repo, "node_modules/.bin/tsc"),
      ["--pretty", "false"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    if (error !== undefined) throw error;
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("fixture.ts("))
      .map((line) => line.replace(/^fixture\.ts\(\d+,\d+\): /u, ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
