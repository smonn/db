import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "../../..");

const ENTRY_POINTS = {
  "@smonn/db": "src/runtime/index.ts",
  "@smonn/db/postgres-js": "src/adapters/postgres-js/index.ts",
  "@smonn/db/node": "src/adapters/node/index.ts",
  "@smonn/db/dev": "src/dev/index.ts",
} as const;

const CONSUMER = `import { defineDatabase, type Fragment } from "@smonn/db";
import { defineConfig, type Config } from "@smonn/db/dev";
import { nodeMigrationSource } from "@smonn/db/node";
import { postgresJsDriver } from "@smonn/db/postgres-js";

export const used: unknown[] = [defineDatabase, defineConfig, nodeMigrationSource, postgresJsDriver];
export type Used = [Fragment, Config];
`;

let dir: string;
let project: string;
let packageJson: string;

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

/** The export names of the module at `specifier`, as Node imports it from `cwd`. */
function exportsOf(specifier: string, cwd: string): string {
  const print = "console.log(Object.keys(await import(process.argv[1])).join())";
  return run("node", ["--input-type=module", "--eval", print, specifier], cwd);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "smonn-db-package-"));
  project = join(dir, "project");
  await mkdir(join(project, "migrations"), { recursive: true });
  packageJson = await readFile(join(repo, "package.json"), "utf8");
  run("pnpm", ["run", "build"], repo);
  const tarball = join(dir, "package.tgz");
  // The build already ran, and prepare's hook install would touch git config.
  run("pnpm", ["pack", "--ignore-scripts", "--out", tarball], repo);
  await writeFile(join(project, "package.json"), '{ "private": true, "type": "module" }\n');
  // The repo's installed postgres stands in for the peer, so the install needs no registry.
  run("pnpm", ["add", "--prefer-offline", tarball, join(repo, "node_modules/postgres")], project);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the packed package", () => {
  it("builds without changing the exports and bin in package.json", async () => {
    // tsdown rewrites them from tsdown.config.ts, so a change means the committed copy is stale.
    await expect(readFile(join(repo, "package.json"), "utf8")).resolves.toBe(packageJson);
  });

  it.each(Object.entries(ENTRY_POINTS))("exports %s as its source does", (name, source) => {
    expect(exportsOf(name, project)).toBe(exportsOf(pathToFileURL(join(repo, source)).href, repo));
  });

  it("types each entry point", async () => {
    await writeFile(join(project, "consumer.ts"), CONSUMER);
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "nodenext", strict: true, noEmit: true, skipLibCheck: true },
        files: ["consumer.ts"],
      }),
    );

    expect(() => run(join(repo, "node_modules/.bin/tsc"), [], project)).not.toThrow();
  });

  it("runs the smonndb bin against a config that imports @smonn/db/dev", async () => {
    await writeFile(
      join(project, "smonndb.config.ts"),
      `import { defineConfig } from "@smonn/db/dev";

export default defineConfig({ definition: "./db.ts", migrations: "./migrations", url: undefined });
`,
    );

    expect(run(join(project, "node_modules/.bin/smonndb"), ["verify"], project)).toBe(
      "verified 0 migrations\n",
    );
  });
});
