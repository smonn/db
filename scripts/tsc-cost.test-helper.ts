import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type Fixture = { dir: string; log: string };

export const diagnostics = (types: number, instantiations: number): string =>
  `Types:           ${types}\nInstantiations:  ${instantiations}\n`;

/**
 * A directory with a fake `node_modules/.bin/tsc`, for a test that runs `tsc-cost.ts` against a
 * temp git repository without paying for a real tsc. Each run appends its directory to the log
 * and prints `cost.txt` plus a check time of its run number in tenths of a second; it exits 3
 * when `node_modules` is not linked into the tree, 2 with an error when `fail.txt` exists, and
 * sleeps for 30 seconds when `slow.txt` exists.
 */
export function createFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsc-cost-test-")));
  const log = join(dir, "..", `${basename(dir)}.log`);
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "node_modules", "marker"), "");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "cost.txt"), diagnostics(100, 1000));
  const tsc = join(bin, "tsc");
  writeFileSync(
    tsc,
    [
      "#!/bin/sh",
      `pwd -P >> "${log}"`,
      "test -f node_modules/marker || exit 3",
      "if [ -e slow.txt ]; then exec sleep 30; fi",
      'if [ -e fail.txt ]; then echo "error TS1: boom"; exit 2; fi',
      "cat cost.txt",
      `printf 'Check time:      0.%ds\\n' "$(wc -l < "${log}" | tr -d ' ')"`,
    ].join("\n"),
  );
  chmodSync(tsc, 0o755);
  return { dir, log };
}

export function removeFixture({ dir, log }: Fixture): void {
  rmSync(dir, { recursive: true, force: true });
  rmSync(log, { force: true });
}

/** The directory each fake tsc run reported, in order. */
export function runDirs({ log }: Fixture): string[] {
  return readFileSync(log, "utf8").trim().split("\n");
}

type ChildProcess = typeof import("node:child_process");
type ExecFileSync = (
  command: string,
  args: readonly string[],
  options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding,
) => string;
type ExecFile = (
  command: string,
  args: readonly string[],
  options: import("node:child_process").ExecFileOptionsWithStringEncoding,
  callback: Parameters<ChildProcess["execFile"]>[3],
) => import("node:child_process").ChildProcess;
type Guarded = Omit<ChildProcess, "execFile" | "execFileSync"> & {
  execFile: ExecFile;
  execFileSync: ExecFileSync;
};

function refuseOthers(command: string): void {
  if (command !== "git" && !command.endsWith("/node_modules/.bin/tsc")) {
    throw new Error(`Only git and the fake tsc may run here, not ${command}`);
  }
}

/**
 * The `node:child_process` a `tsc-cost` test runs against: real git and the fake tsc, with any
 * other command (such as gh) refused. Pass it to `vi.mock` through a dynamic import, since the
 * hoisted mock runs before this file's static imports.
 */
export function guardChildProcess(actual: ChildProcess): Guarded {
  const execFileSync: ExecFileSync = (command, args, options) => {
    refuseOthers(command);
    return actual.execFileSync(command, args, options);
  };
  const execFile: ExecFile = (command, args, options, callback) => {
    refuseOthers(command);
    return actual.execFile(command, args, options, callback);
  };
  return { ...actual, execFile, execFileSync };
}
