/**
 * Runs actionlint on `.github/workflows/` from a pinned release binary, so linting a workflow
 * needs no Docker. The first run downloads the release for this platform, checks it against the
 * pinned sha256, and caches the binary under `node_modules/.cache/actionlint/<version>/`.
 *
 * Run from the repo root with `pnpm lint:actions`; CI runs it in the Lint job. Bumping `version`
 * also means copying the new sums from the release's `actionlint_<version>_checksums.txt`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const version = "1.7.12";

const sums: Record<string, string> = {
  darwin_amd64: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  darwin_arm64: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  linux_amd64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  linux_arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
};

const goArch: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export function assetFor(platform: string, arch: string): { name: string; sha256: string } {
  const target = `${platform}_${goArch[arch] ?? arch}`;
  const sha256 = sums[target];
  if (sha256 === undefined) {
    throw new Error(`actionlint ${version} has no pinned release for ${platform}/${arch}`);
  }
  return { name: `actionlint_${version}_${target}.tar.gz`, sha256 };
}

export async function install(
  cacheDir: string,
  platform: string = process.platform,
  arch: string = process.arch,
  sha256: string = assetFor(platform, arch).sha256,
): Promise<string> {
  const dir = join(cacheDir, version);
  const binary = join(dir, "actionlint");
  if (existsSync(binary)) return binary;

  const { name } = assetFor(platform, arch);
  const url = `https://github.com/rhysd/actionlint/releases/download/v${version}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${name} has sha256 ${actual}, which does not match the pinned ${sha256}`);
  }

  mkdirSync(dir, { recursive: true });
  const archive = join(dir, name);
  writeFileSync(archive, tarball);
  const tar = spawnSync("tar", ["-xzf", archive, "-C", dir, "actionlint"], { stdio: "inherit" });
  rmSync(archive);
  if (tar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`tar could not extract ${name}`);
  }
  return binary;
}

export async function main(args: string[] = process.argv.slice(2), cwd = "."): Promise<void> {
  const binary = await install(join(cwd, "node_modules", ".cache", "actionlint"));
  const result = spawnSync(binary, args, { cwd, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (import.meta.main) await main();
