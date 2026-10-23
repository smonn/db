import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

export const repo: string = join(import.meta.dirname, "../../..");

export function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

export type PackedPackage = {
  /** The built package as `pnpm pack` writes it. */
  readonly tarball: string;
  /** The repo's package.json as it was before the build rewrote anything. */
  readonly packageJson: string;
  /** `pnpm add` arguments that install the tarball and a postgres peer without the registry. */
  readonly installArgs: readonly string[];
};

/** Builds and packs the package once for the file's tests, then removes the tarball. */
export function usePackedPackage(): PackedPackage {
  let dir: string;
  let tarball: string;
  let packageJson: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "smonn-db-packed-"));
    tarball = join(dir, "package.tgz");
    packageJson = await readFile(join(repo, "package.json"), "utf8");
    run("pnpm", ["run", "build"], repo);
    // The build already ran, and prepare's hook install would touch git config.
    run("pnpm", ["pack", "--ignore-scripts", "--out", tarball], repo);
  }, 120_000);

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
    // The repo's installed postgres stands in for the peer, so the install needs no registry.
    get installArgs() {
      return ["add", "--prefer-offline", tarball, join(repo, "node_modules/postgres")];
    },
  };
}
