/**
 * What `live-input-checks.ts` runs: a probe is one repo check on one live sample. It returns what
 * the check refused and throws when the check does. `readOnlyGh` keeps an issue check from writing
 * to GitHub, and `captureRefusals` reads the refusals of a check that reports through
 * `console.error` and the exit code.
 */
import type { Source } from "./live-input-source.ts";

export type Outcome = "passed" | "refused" | "threw";

export type Result = { check: string; sample: string; outcome: Outcome; lines: string[] };

export type Probe = { check: string; sample: string; run: () => string[] };

export type Check = {
  name: string;
  /** The scripts whose change can change the check's result. */
  files: string[];
  probes: (source: Source) => Probe[];
};

export type Gh = (args: string[]) => string;

const READ_FLAGS = new Set(["--paginate", "--slurp"]);
const EXCERPT = 200;

function describeWrite(args: string[]): string {
  const body = args.indexOf("--body");
  if (body === -1) return `would run gh ${args.join(" ")}`;
  const rest = args.filter((_, index) => index !== body && index !== body + 1);
  const text = (args[body + 1] ?? "").split("\n").join(" ").slice(0, EXCERPT);
  return `would run gh ${rest.join(" ")} "${text}"`;
}

/**
 * A `gh` that runs a GET through `read` and records anything else instead of running it, so a check
 * built to comment or label cannot. A flag outside `READ_FLAGS` (`-X`, `-f`, `--input`) or a
 * subcommand other than `api` counts as a write.
 */
export function readOnlyGh(read: Gh, writes: string[]): Gh {
  return (args) => {
    if (args[0] === "api" && args.slice(1).every((a) => READ_FLAGS.has(a) || !a.startsWith("-"))) {
      return read(args);
    }
    writes.push(describeWrite(args));
    return "";
  };
}

/** The lines a check wrote with `console.error`, which is how the checks report a refusal. */
export function captureRefusals(run: () => void): string[] {
  const lines: string[] = [];
  const { error } = console;
  const { exitCode } = process;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
    if (lines.length === 0 && process.exitCode !== undefined && process.exitCode !== 0) {
      lines.push(`exited with code ${String(process.exitCode)}`);
    }
  } finally {
    console.error = error;
    process.exitCode = exitCode;
  }
  return lines;
}

export function runProbe({ check, sample, run }: Probe): Result {
  try {
    const lines = run();
    return { check, sample, outcome: lines.length === 0 ? "passed" : "refused", lines };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { check, sample, outcome: "threw", lines: [message] };
  }
}
