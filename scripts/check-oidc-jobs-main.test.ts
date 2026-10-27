import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-oidc-jobs.ts";

// Stryker rewrites the file's literals, so under mutation its text no longer holds the pins Renovate reads.
const instrumented = readFileSync(join("scripts", "check-oidc-jobs.ts"), "utf8").includes(
  "stryMutAct",
);

describe("main", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function setupRepo(lockfile: string): void {
    dir = mkdtempSync(join(tmpdir(), "check-oidc-jobs-"));
    const workflows = join(dir, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), lockfile);
    copyFileSync(join(".github", "workflows", "release.yml"), join(workflows, "release.yml"));
    writeFileSync(join(workflows, "notes.txt"), "id-token: write");
  }

  test("passes on this repo's workflows and lockfile", () => {
    main(".");
    expect(process.exitCode).toBeUndefined();
  });

  test("prints each problem with its file and sets exit code 1", () => {
    setupRepo(
      "    packageManagerDependencies:\n      pnpm:\n        specifier: ^99.0.0\n        version: 99.0.0\n",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    main(dir);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^release\.yml job publish .*expected " {8}version: 99\.0\.0"/u),
    );
    expect(process.exitCode).toBe(1);
  });

  test.skipIf(instrumented)("lets Renovate bump every action SHA that publishJob pins", () => {
    const matchString = String.raw`// (?<currentValue>v\S+)\n\s*"\s*- uses: (?<depName>[\w.-]+/[\w.-]+)@(?<currentDigest>[0-9a-f]{40})"`;
    const renovate = readFileSync(join(".github", "renovate.json"), "utf8");
    expect(renovate).toContain(JSON.stringify([String.raw`/^scripts/check-oidc-jobs\.ts$/`]));
    expect(renovate).toContain(
      `"matchStrings": [\n        ${JSON.stringify(matchString)}\n      ]`,
    );
    const source = readFileSync(join("scripts", "check-oidc-jobs.ts"), "utf8");
    const bumped = [...source.matchAll(new RegExp(matchString, "gu"))].map((match) =>
      match.slice(2).join("@"),
    );
    const pinned = [...source.matchAll(/"\s*- uses: ([^"]+)"/gu)].map((match) => match[1]);
    expect(pinned).toHaveLength(2);
    expect(bumped).toEqual(pinned);
  });

  test("fails when the lockfile resolves no pnpm version", () => {
    setupRepo("importers: {}\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    main(dir);
    expect(error).toHaveBeenCalledWith(
      "pnpm-lock.yaml has no packageManagerDependencies entry for pnpm",
    );
    expect(process.exitCode).toBe(1);
  });
});
