import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-oidc-jobs.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>(actual.readFileSync) };
});

const lockfile =
  "    packageManagerDependencies:\n      pnpm:\n        specifier: ^12.14.0\n        version: 12.14.0\n";

describe("main's files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-oidc-jobs-fs-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), lockfile);
    writeFileSync(join(dir, ".github", "workflows", "a.yml"), "name: a\n");
    writeFileSync(join(dir, ".github", "workflows", "b.yaml"), "permissions: write-all\n");
    writeFileSync(join(dir, ".github", "workflows", "c.yml.bak"), "permissions: write-all\n");
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("checks .yml and .yaml files only, reading each as UTF-8", () => {
    vi.mocked(readFileSync).mockClear();
    main(dir);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "b.yaml grants write-all, which includes id-token; grant id-token alone",
    );
    expect(process.exitCode).toBe(1);
    const encodings = vi.mocked(readFileSync).mock.calls.map(([, encoding]) => encoding);
    expect(encodings).toEqual(["utf8", "utf8", "utf8"]);
  });
});
