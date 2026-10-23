import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repo, run, usePackedPackage } from "./packed-package.test-helper.ts";
import { topLevelEffects } from "./top-level-effects.test-helper.ts";

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

/** The manifest consumers get: read from the tarball, not the repo's package.json. */
function packedManifest(): unknown {
  return JSON.parse(packed.packedManifest);
}

/** Export targets that are not built files in `dist/`; `package.json` itself is the one allowed. */
function outsideDist(): string[] {
  const targets = Object.values(packedExportMap());
  return targets.filter((target) => target !== "./package.json" && !target.startsWith("./dist/"));
}

function packedExportMap(): Record<string, string> {
  return stringRecord(field(packedManifest(), "exports"), "packed package.json exports");
}

/** Each export built from `dist/`, as its import specifier and the source tsdown builds it from. */
function entryPoints(): (readonly [string, string])[] {
  return Object.entries(packedExportMap())
    .filter(([, target]) => target.startsWith("./dist/"))
    .map(([subpath, target]) => {
      const source = entries[basename(target, ".mjs")];
      if (source === undefined) throw new Error(`${subpath} has no entry in tsdown.config.ts`);
      return [subpath === "." ? "@smonn/db" : `@smonn/db/${subpath.slice(2)}`, source] as const;
    });
}

/** What each installed `dist/` module outside `sideEffects` runs at import, by `./dist/` path. */
async function effectsOutsideSideEffects(): Promise<Record<string, string[]>> {
  const declared: unknown = field(packedManifest(), "sideEffects");
  const files = await readdir(join(project, "node_modules/@smonn/db/dist"));
  const pure = files
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => `./dist/${file}`)
    .filter((file) => !(Array.isArray(declared) && declared.includes(file)));
  const effects = await Promise.all(
    pure.map(async (file) => {
      const source = await readFile(join(project, "node_modules/@smonn/db", file), "utf8");
      return [file, topLevelEffects(source)] as const;
    }),
  );
  return Object.fromEntries(effects);
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
  await writeFile(join(project, "package.json"), '{ "private": true, "type": "module" }\n');
  run("pnpm", packed.installArgs, project);
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the packed package", () => {
  it("builds without changing the exports and bin in package.json", () => {
    // tsdown rewrites them from tsdown.config.ts, so a change means the committed copy is stale.
    expect(packed.builtPackageJson).toBe(packed.packageJson);
  });

  it("points every export at a built file in dist/", () => {
    expect(outsideDist()).toEqual([]);
  });

  it("declares only the bin as having side effects", () => {
    // The bin runs main() at import; every other built module is declarations only.
    const bins = Object.values(stringRecord(field(packedManifest(), "bin"), "packed bin"));
    expect(field(packedManifest(), "sideEffects")).toEqual(bins);
  });

  it("runs no code at import in a built module outside sideEffects", async () => {
    const effects = await effectsOutsideSideEffects();
    expect(Object.keys(effects)).not.toHaveLength(0);
    expect(Object.entries(effects).filter(([, found]) => found.length > 0)).toEqual([]);
  });

  it("exports each entry point as its source does", () => {
    const points = entryPoints();
    const installed = points.map(([name]) => [name, exportsOf(name, project)]);
    const sources = points.map(([name, source]) => [
      name,
      exportsOf(pathToFileURL(join(repo, source)).href, repo),
    ]);
    expect(installed).not.toHaveLength(0);
    expect(installed).toEqual(sources);
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
