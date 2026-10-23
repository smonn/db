import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repo, run, usePackedPackage } from "./packed-package.test-helper.ts";

function stringRecord(value: unknown, what: string): Record<string, string> {
  const isStrings =
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => typeof item === "string");
  if (!isStrings) throw new Error(`${what} is not a map of strings`);
  return Object.fromEntries(Object.entries(value));
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

// Imported by URL so the import-rule check, which cruises src/, doesn't follow it out of src/.
const config: unknown = await import(pathToFileURL(join(repo, "tsdown.config.ts")).href);
const entries = stringRecord(field(field(config, "default"), "entry"), "tsdown.config.ts entry");
const manifest: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const exportMap = stringRecord(field(manifest, "exports"), "package.json exports");

// Each public export, paired with the source of the entry tsdown builds it from.
const ENTRY_POINTS = Object.entries(exportMap)
  .filter(([, target]) => target.startsWith("./dist/"))
  .map(([subpath, target]) => {
    const source = entries[basename(target, ".mjs")];
    if (source === undefined) throw new Error(`${subpath} has no entry in tsdown.config.ts`);
    return [subpath === "." ? "@smonn/db" : `@smonn/db/${subpath.slice(2)}`, source] as const;
  });

const CONSUMER = `import { defineDatabase, type Fragment } from "@smonn/db";
import { defineConfig, type Config } from "@smonn/db/dev";
import { nodeMigrationSource } from "@smonn/db/node";
import { postgresJsDriver } from "@smonn/db/postgres-js";

export const used: unknown[] = [defineDatabase, defineConfig, nodeMigrationSource, postgresJsDriver];
export type Used = [Fragment, Config];
`;

const packed = usePackedPackage();
let dir: string;
let project: string;

/** The export names of the module at `specifier`, as Node imports it from `cwd`. */
function exportsOf(specifier: string, cwd: string): string {
  const print = "console.log(Object.keys(await import(process.argv[1])).join())";
  return run("node", ["--input-type=module", "--eval", print, specifier], cwd);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "smonn-db-package-"));
  project = join(dir, "project");
  await mkdir(join(project, "migrations"), { recursive: true });
  await writeFile(join(project, "package.json"), '{ "private": true, "type": "module" }\n');
  run("pnpm", packed.installArgs, project);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the packed package", () => {
  it("builds without changing the exports and bin in package.json", async () => {
    // tsdown rewrites them from tsdown.config.ts, so a change means the committed copy is stale.
    await expect(readFile(join(repo, "package.json"), "utf8")).resolves.toBe(packed.packageJson);
  });

  it("declares only the bin as having side effects", () => {
    // The bin runs main() at import; every other built module is declarations only.
    const bins = Object.values(stringRecord(field(manifest, "bin"), "package.json bin"));
    expect(field(manifest, "sideEffects")).toEqual(bins);
  });

  it.each(ENTRY_POINTS)("exports %s as its source does", (name, source) => {
    expect(exportsOf(name, project)).toBe(exportsOf(pathToFileURL(join(repo, source)).href, repo));
  });

  it("types each entry point", async () => {
    await writeFile(join(project, "consumer.ts"), CONSUMER);
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          strict: true,
          noEmit: true,
          // postgres's types need @types/node, which the project doesn't install.
          typeRoots: [join(repo, "node_modules/@types")],
          types: ["node"],
        },
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
