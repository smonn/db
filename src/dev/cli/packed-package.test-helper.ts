import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll } from "vitest";

export const repo: string = join(import.meta.dirname, "../../..");

export function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

/**
 * Vitest runs test files in parallel workers, and a build rewrites dist/ and package.json under
 * a concurrent build or pack. A directory is an atomic cross-process lock, one per checkout.
 */
async function acquire(lock: string): Promise<void> {
  try {
    await mkdir(lock);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    // A run killed mid-build leaves its lock behind; a build never takes this long.
    const held = await stat(lock).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > 120_000) {
      await rm(lock, { recursive: true, force: true });
    }
    await setTimeout(100);
    await acquire(lock);
  }
}

async function withBuildLock<T>(action: () => Promise<T> | T): Promise<T> {
  const lock = join(tmpdir(), `smonn-db-build-${createHash("sha1").update(repo).digest("hex")}`);
  await acquire(lock);
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** The `name` in a package.json. */
export function nameOf(manifest: string): string {
  const parsed: unknown = JSON.parse(manifest);
  const name: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "name") : undefined;
  if (typeof name !== "string") throw new Error("package.json has no name");
  return name;
}

export type PackedPackage = {
  /** The built package as `pnpm pack` writes it. */
  readonly tarball: string;
  /** The repo's package.json as it was before the build. */
  readonly packageJson: string;
  /** The repo's package.json as it was right after the build. */
  readonly builtPackageJson: string;
  /** The package.json inside the tarball: the manifest consumers get, not the repo's. */
  readonly packedManifest: string;
  /** `pnpm add` arguments that install the tarball and a postgres peer without the registry. */
  readonly installArgs: readonly string[];
};

/** Builds and packs the package once for the file's tests, then removes the tarball. */
export function usePackedPackage(): PackedPackage {
  let dir: string;
  let tarball: string;
  let packageJson: string;
  let builtPackageJson: string;
  let packedManifest: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "smonn-db-packed-"));
    tarball = join(dir, "package.tgz");
    await withBuildLock(async () => {
      packageJson = await readFile(join(repo, "package.json"), "utf8");
      run("pnpm", ["run", "build"], repo);
      builtPackageJson = await readFile(join(repo, "package.json"), "utf8");
      // The build already ran, and prepare's hook install would touch git config.
      run("pnpm", ["pack", "--ignore-scripts", "--out", tarball], repo);
    });
    packedManifest = run("tar", ["-xzOf", tarball, "package/package.json"], dir);
  }, 240_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get tarball() {
      return tarball;
    },
    get packageJson() {
      return packageJson;
    },
    get builtPackageJson() {
      return builtPackageJson;
    },
    get packedManifest() {
      return packedManifest;
    },
    // The repo's installed postgres stands in for the peer, so the install needs no registry.
    get installArgs() {
      return ["add", "--prefer-offline", tarball, join(repo, "node_modules/postgres")];
    },
  };
}
