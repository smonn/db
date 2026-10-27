import { describe, expect, test } from "vitest";
import { checkNodeVersion, type NodeVersionSources } from "./check-node-version.ts";

function lockfile(specifier: string, version: string): string {
  return `importers:\n\n  .:\n    devDependencies:\n      node:\n        specifier: ${specifier}\n        version: ${version}\n\npackages:\n\n  node@runtime:24.22.1:\n    hasBin: true\n`;
}

const runtime = (value: unknown): string => JSON.stringify({ devEngines: { runtime: value } });

function sources(overrides: Partial<NodeVersionSources> = {}): NodeVersionSources {
  return {
    toolVersions: "nodejs 24.22.1\n",
    packageJson: runtime({ name: "node", version: "^24.22.1" }),
    lockfile: lockfile("runtime:^24.22.1", "runtime:24.22.1"),
    ...overrides,
  };
}

const noVersion = ["package.json devEngines.runtime has no node version"];

describe("checkNodeVersion package.json shapes", () => {
  test.each([
    ["null", "null"],
    ["devEngines of null", JSON.stringify({ devEngines: null })],
    ["no devEngines", "{}"],
    ["no runtime", JSON.stringify({ devEngines: {} })],
    ["a runtime holding null", runtime(null)],
    ["a node entry with a number for its version", runtime({ name: "node", version: 24 })],
    ["a node entry with no version", runtime({ name: "node" })],
    ["a version on another runtime", runtime({ name: "bun", version: "1" })],
  ])("names a missing node version for %s", (_name, packageJson) => {
    expect(checkNodeVersion(sources({ packageJson }))).toEqual(noVersion);
  });

  test("skips a null entry in the runtime list", () => {
    const packageJson = runtime([null, { name: "node", version: "^24.22.1" }]);
    expect(checkNodeVersion(sources({ packageJson }))).toEqual([]);
  });

  test("names package.json when it is not JSON", () => {
    expect(() => checkNodeVersion(sources({ packageJson: "{" }))).toThrow(
      "package.json: invalid JSON",
    );
  });
});

describe("checkNodeVersion .tool-versions shapes", () => {
  test.each([
    "# nodejs 20.0.0\nnodejs 24.22.1\n",
    "nodejs    24.22.1  \t\n",
    "python 3.13\nnodejs\t24.22.1",
  ])("reads the nodejs line of %j", (toolVersions) => {
    expect(checkNodeVersion(sources({ toolVersions }))).toEqual([]);
  });

  test.each(["# nodejs 24.22.1\n", "xnodejs 24.22.1\n", "nodejs 24.22.1 20.0.0\n", "nodejs\n"])(
    "finds no nodejs entry in %j",
    (toolVersions) => {
      expect(checkNodeVersion(sources({ toolVersions }))).toEqual([
        ".tool-versions has no nodejs entry",
      ]);
    },
  );
});

describe("checkNodeVersion lockfile shapes", () => {
  test("reads the importer only at its own indentation", () => {
    const lock = lockfile("runtime:^24.22.1", "runtime:24.22.1").replace(
      "      node:",
      "        node:",
    );
    expect(checkNodeVersion(sources({ lockfile: lock }))).toEqual([
      "pnpm-lock.yaml has no node runtime importer entry",
    ]);
  });

  test("reads the importer's version to the end of its line", () => {
    const lock = lockfile("runtime:^24.22.1", "runtime:24.22.1 # pinned");
    expect(checkNodeVersion(sources({ lockfile: lock }))).toEqual([
      "pnpm-lock.yaml has no node runtime importer entry",
    ]);
  });

  test("reads package keys only at their own indentation", () => {
    const lock = `${lockfile("runtime:^24.22.1", "runtime:24.22.1")}    node@runtime:99.9.9:\n`;
    expect(checkNodeVersion(sources({ lockfile: lock }))).toEqual([]);
  });
});
