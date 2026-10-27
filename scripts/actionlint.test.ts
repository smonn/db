import { createHash } from "node:crypto";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assetFor, install, main, version } from "./actionlint.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const spawn = vi.mocked(spawnSync);
const ok: SpawnSyncReturns<string> = {
  pid: 0,
  output: [],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
};
const tarball = Buffer.from("tarball");
let root: string;

function serve(body: Buffer, status = 200): ReturnType<typeof vi.fn<typeof fetch>> {
  const fake = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status })));
  vi.stubGlobal("fetch", fake);
  return fake;
}

// Stands in for tar: extracting writes the binary next to the archive.
function extractWrites(): void {
  spawn.mockImplementation((command, args) => {
    if (command === "tar") {
      const list = args ?? [];
      writeFileSync(join(list[list.indexOf("-C") + 1] ?? "", "actionlint"), "binary");
    }
    return ok;
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "actionlint-"));
  spawn.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("assetFor", () => {
  test("maps Node's platform and arch onto the release asset names", () => {
    expect(assetFor("darwin", "arm64").name).toBe(`actionlint_${version}_darwin_arm64.tar.gz`);
    expect(assetFor("linux", "x64").name).toBe(`actionlint_${version}_linux_amd64.tar.gz`);
  });

  test.each([
    ["darwin", "x64", "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"],
    ["darwin", "arm64", "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"],
    ["linux", "x64", "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"],
    ["linux", "arm64", "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"],
  ])("pins the release sum for %s %s", (platform, arch, sha256) => {
    expect(assetFor(platform, arch).sha256).toBe(sha256);
  });

  test("refuses a platform with no pinned sum", () => {
    expect(() => assetFor("win32", "x64")).toThrow(`no pinned release for win32/x64`);
  });
});

describe("install", () => {
  test("downloads the release, checks its sum, and extracts the binary", async () => {
    const asset = assetFor("linux", "x64");
    const fake = serve(tarball);
    extractWrites();
    const pinned = createHash("sha256").update(tarball).digest("hex");

    const binary = await install(root, "linux", "x64", pinned);

    expect(fake).toHaveBeenCalledWith(
      `https://github.com/rhysd/actionlint/releases/download/v${version}/${asset.name}`,
    );
    expect(binary).toBe(join(root, version, "actionlint"));
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(join(root, version, asset.name))).toBe(false);
  });

  test("creates missing cache folders and extracts into the version folder", async () => {
    serve(tarball);
    extractWrites();
    const pinned = createHash("sha256").update(tarball).digest("hex");
    const cacheDir = join(root, "node_modules", ".cache", "actionlint");
    const dir = join(cacheDir, version);

    await install(cacheDir, "linux", "x64", pinned);

    expect(spawn).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(dir, `actionlint_${version}_linux_amd64.tar.gz`), "-C", dir, "actionlint"],
      { stdio: "inherit" },
    );
  });

  test("refuses a download whose sum does not match and caches nothing", async () => {
    serve(tarball);
    extractWrites();

    await expect(install(root, "linux", "x64", "0".repeat(64))).rejects.toThrow(
      "does not match the pinned",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, version))).toBe(false);
  });

  test("refuses a failed download", async () => {
    serve(Buffer.from(""), 404);

    await expect(install(root, "linux", "x64")).rejects.toThrow("404");
  });

  test("removes a half-extracted version when tar fails", async () => {
    serve(tarball);
    spawn.mockReturnValue({ ...ok, status: 2 });
    const pinned = createHash("sha256").update(tarball).digest("hex");

    await expect(install(root, "linux", "x64", pinned)).rejects.toThrow("tar could not extract");
    expect(existsSync(join(root, version))).toBe(false);
  });

  test("reuses a cached binary without downloading", async () => {
    mkdirSync(join(root, version), { recursive: true });
    writeFileSync(join(root, version, "actionlint"), "binary");
    const fake = serve(tarball);

    await install(root, "linux", "x64");

    expect(fake).not.toHaveBeenCalled();
  });
});

describe("main", () => {
  test("runs the cached binary with the given args and passes on its exit code", async () => {
    const binary = join(root, "node_modules", ".cache", "actionlint", version, "actionlint");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "binary");
    spawn.mockReturnValue({ ...ok, status: 1 });

    await main(["-color"], root);

    expect(spawn).toHaveBeenCalledWith(binary, ["-color"], { cwd: root, stdio: "inherit" });
    expect(process.exitCode).toBe(1);
  });

  test("passes on any exit code, and fails when the binary was killed", async () => {
    const binary = join(root, "node_modules", ".cache", "actionlint", version, "actionlint");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "binary");
    spawn.mockReturnValue({ ...ok, status: 3 });
    await main([], root);
    expect(process.exitCode).toBe(3);

    spawn.mockReturnValue({ ...ok, status: null });
    await main([], root);
    expect(process.exitCode).toBe(1);
  });

  test("defaults to the arguments after the script, run from the current folder", async () => {
    const start = process.cwd();
    const binary = join("node_modules", ".cache", "actionlint", version, "actionlint");
    mkdirSync(join(root, binary, ".."), { recursive: true });
    writeFileSync(join(root, binary), "binary");
    spawn.mockReturnValue(ok);
    process.chdir(root);
    try {
      await main();
    } finally {
      process.chdir(start);
    }
    expect(spawn).toHaveBeenCalledWith(binary, process.argv.slice(2), {
      cwd: ".",
      stdio: "inherit",
    });
  });
});
