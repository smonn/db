import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkNodeVersion, main, type NodeVersionSources } from "./check-node-version.ts";

function lockfile(specifier: string, version: string, keys: string[] = [version]): string {
  const packages = keys.map((key) => `  node@runtime:${key}:\n    hasBin: true\n`).join("\n");
  return `importers:\n\n  .:\n    devDependencies:\n      node:\n        specifier: ${specifier}\n        version: ${version}\n\npackages:\n\n${packages}`;
}

const node24 = { name: "node", version: "^24.22.1" };

function packageJson(runtime: unknown = node24, types = "^24.19.2"): string {
  return JSON.stringify({ devEngines: { runtime }, devDependencies: { "@types/node": types } });
}

function sources(overrides: Partial<NodeVersionSources> = {}): NodeVersionSources {
  return {
    toolVersions: "nodejs 24.22.1\n",
    packageJson: packageJson(),
    lockfile: lockfile("runtime:^24.22.1", "runtime:24.22.1", ["24.22.1"]),
    ...overrides,
  };
}

describe("checkNodeVersion", () => {
  test("accepts three agreeing copies", () => {
    expect(checkNodeVersion(sources())).toEqual([]);
  });

  test("accepts devEngines.runtime as an array", () => {
    const pkg = packageJson([{ name: "node", version: "^24.22.1" }]);
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([]);
  });

  test("finds the node entry after a non-node entry in the array", () => {
    const pkg = packageJson([
      { name: "bun", version: "1" },
      { name: "node", version: "^24.22.1" },
    ]);
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([]);
  });

  test.each(["24", "~24.0.0", "24.x"])("accepts @types/node %s on Node 24", (types) => {
    const pkg = packageJson(undefined, types);
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([]);
  });

  test("flags an @types/node major that differs from .tool-versions", () => {
    const pkg = packageJson(undefined, "^26.0.0");
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([
      "package.json @types/node is ^26.0.0, expected major 24 (.tool-versions)",
    ]);
  });

  test("flags an @types/node with no leading major", () => {
    const pkg = packageJson(undefined, "npm:@types/node@24.0.0");
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([
      "package.json @types/node is npm:@types/node@24.0.0, expected major 24 (.tool-versions)",
    ]);
  });

  test("flags an @types/node major that only prefixes the runtime major", () => {
    const pkg = packageJson(undefined, "^2.0.0");
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([
      "package.json @types/node is ^2.0.0, expected major 24 (.tool-versions)",
    ]);
  });

  test("flags an asdf version that differs from the lockfile", () => {
    const problems = checkNodeVersion(sources({ toolVersions: "nodejs 24.22.2\n" }));
    expect(problems).toEqual([
      "pnpm-lock.yaml node version is runtime:24.22.1, expected runtime:24.22.2 (.tool-versions)",
      "pnpm-lock.yaml has node@runtime:24.22.1, expected 24.22.2 (.tool-versions)",
    ]);
  });

  test("flags a lockfile specifier that differs from devEngines", () => {
    const pkg = packageJson({ name: "node", version: "^24" });
    expect(checkNodeVersion(sources({ packageJson: pkg }))).toEqual([
      "pnpm-lock.yaml node specifier is runtime:^24.22.1, expected runtime:^24 (devEngines.runtime)",
    ]);
  });

  test("flags a stale package key beside a correct importer", () => {
    const lock = lockfile("runtime:^24.22.1", "runtime:24.22.1", ["24.22.1", "24.22.0"]);
    expect(checkNodeVersion(sources({ lockfile: lock }))).toEqual([
      "pnpm-lock.yaml has node@runtime:24.22.0, expected 24.22.1 (.tool-versions)",
    ]);
  });

  test.each([
    [{ toolVersions: "python 3.13\n" }, ".tool-versions has no nodejs entry"],
    [{ packageJson: "{}" }, "package.json devEngines.runtime has no node version"],
    [{ lockfile: "importers: {}\n" }, "pnpm-lock.yaml has no node runtime importer entry"],
    [
      {
        lockfile:
          "importers:\n  .:\n    devDependencies:\n      node:\n        specifier: runtime:^24.22.1\n        version: runtime:24.22.1\n",
      },
      "pnpm-lock.yaml has no node@runtime package entry",
    ],
  ])("names a missing source %#", (override, message) => {
    expect(checkNodeVersion(sources(override))).toContain(message);
  });
});

describe("main", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function setup(s: NodeVersionSources): void {
    dir = mkdtempSync(join(tmpdir(), "check-node-version-"));
    writeFileSync(join(dir, ".tool-versions"), s.toolVersions);
    writeFileSync(join(dir, "package.json"), s.packageJson);
    writeFileSync(join(dir, "pnpm-lock.yaml"), s.lockfile);
  }

  test("leaves the exit code alone when the copies agree", () => {
    setup(sources());
    main(dir);
    expect(process.exitCode).toBeUndefined();
  });

  test("prints each problem and sets exit code 1", () => {
    setup(sources({ toolVersions: "nodejs 24.22.2\n" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    main(dir);
    expect(error).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });
});
