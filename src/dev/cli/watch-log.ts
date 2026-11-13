import { relative } from "node:path";
import { styleText } from "node:util";
import { CatchUpFailedError } from "../generate/index.ts";
import { generatedLines, generateReport } from "./report.ts";
import type { WatchRun } from "./watch.ts";

/** What a good run did, as its line says it. */
type RunOutcome = "initial" | "changed" | "unchanged" | "fixed";

/**
 * The facts one run's line shows, apart from how they print. `trigger` is the paths whose change
 * started the run, relative to the working directory, empty for the run at start.
 */
type RunLine = {
  readonly at: Date;
  readonly trigger: readonly string[];
  readonly durationMs: number;
} & (
  | { readonly ok: true; readonly outcome: RunOutcome }
  | {
      readonly ok: false;
      /** When the last good run began, whose Dev database a failed run keeps; none before one. */
      readonly keptFrom: Date | undefined;
    }
);

/** Where the log goes: the log on stdout, a failure's error on stderr, as one-shot generate does. */
export type WatchLogSink = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Whether it may color the log. */
  readonly color: boolean;
  readonly cwd: string;
};

export type WatchLog = {
  /** Prints what watch watches, once its lock is held. Both paths are absolute. */
  watching(definition: string, migrations: string): void;
  report(run: WatchRun): void;
  stopped(at: Date): void;
};

/** The width of `HH:MM:SS `, so a report sits under the line it belongs to. */
const INDENT = " ".repeat(9);

type GoodRun = Extract<WatchRun, { readonly ok: true }>;
type FailedRun = Extract<WatchRun, { readonly ok: false }>;

export type RunTracker = {
  /** `unchanged` says the run had nothing to report. */
  good(run: GoodRun, unchanged: boolean): RunLine;
  failed(run: FailedRun): RunLine;
};

/** Turns each run into its `RunLine`, remembering the last good run and how the last run ended. */
export function runTracker(cwd: string): RunTracker {
  /** Whether the run before ended well, unknown before the first. */
  let previousOk: boolean | undefined;
  let lastGood: Date | undefined;
  const base = (run: WatchRun) => ({
    at: run.startedAt,
    trigger: run.changes.map((path) => relative(cwd, path)),
    durationMs: run.durationMs,
  });
  return {
    good(run, unchanged) {
      const outcome = goodOutcome(previousOk, unchanged);
      previousOk = true;
      lastGood = run.startedAt;
      return { ...base(run), ok: true, outcome };
    },
    failed(run) {
      previousOk = false;
      return { ...base(run), ok: false, keptFrom: lastGood };
    },
  };
}

/**
 * The append-only log of `generate --watch` (ADR-0032): one line per run, local time first, and
 * its report indented under it. It never clears the screen, because a catch-up can apply
 * data-loss Hazards and the scrollback must keep them.
 */
export function watchLog({ out, err, color, cwd }: WatchLogSink): WatchLog {
  const tracker = runTracker(cwd);
  const paint = painter(color);
  return {
    watching(definition, migrations) {
      const folder = `${relative(cwd, migrations)}/`;
      out(
        `watching ${relative(cwd, definition)} and what it imports, and ${folder} (Ctrl-C to stop)`,
      );
    },
    report(run) {
      if (run.ok) {
        const lines = generateReport(run.result, relative(cwd, run.result.path));
        out(head(tracker.good(run, lines.length === 0), paint));
        for (const line of indent(lines)) out(line);
        return;
      }
      const line = tracker.failed(run);
      out(head(line, paint));
      for (const text of failureOut(run.error, cwd)) out(text);
      for (const text of failureErr(run.error, line, paint)) err(text);
    },
    stopped(at) {
      out(`${paint("dim", clock(at))} stopped`);
    },
  };
}

type Paint = (format: Parameters<typeof styleText>[0], text: string) => string;

function painter(color: boolean): Paint {
  return (format, text) => (color ? styleText(format, text, { validateStream: false }) : text);
}

/** The lines for what a failed catch-up settled in the files, as one-shot generate prints them. */
function failureOut(error: unknown, cwd: string): string[] {
  if (!(error instanceof CatchUpFailedError)) return [];
  const { generated } = error;
  return indent(generatedLines(generated, relative(cwd, generated.path)));
}

function failureErr(error: unknown, line: RunLine, paint: Paint): string[] {
  return [
    ...indent([error instanceof Error ? error.message : String(error)]),
    `${INDENT}${paint("yellow", `kept the Dev database ${keptFrom(line)}`)}`,
  ];
}

function indent(lines: readonly string[]): string[] {
  return lines.flatMap((line) => line.split("\n")).map((line) => `${INDENT}${line}`);
}

/** The line that opens a run: time, status, what it was about, and how long it took. */
function head(line: RunLine, paint: Paint): string {
  const time = paint("dim", clock(line.at));
  const status = line.ok ? paint("green", "ok") : paint("red", "failed");
  const [first, ...more] = line.trigger;
  if (first === undefined) {
    return `${time} ${status} initial run ${paint("dim", `(${duration(line)})`)}`;
  }
  const label = line.ok ? outcomeLabel(line.outcome) : "";
  const trigger = `${first}${more.length === 0 ? "" : ` and ${more.length} more`} changed`;
  return `${time} ${status} ${label}${paint("dim", `${trigger}, ${duration(line)}`)}`;
}

function goodOutcome(previousOk: boolean | undefined, unchanged: boolean): RunOutcome {
  if (previousOk === undefined) return "initial";
  if (!previousOk) return "fixed";
  return unchanged ? "unchanged" : "changed";
}

function outcomeLabel(outcome: RunOutcome): string {
  if (outcome === "fixed") return "fixed ";
  if (outcome === "unchanged") return "no change ";
  return "";
}

function keptFrom(line: RunLine): string {
  return line.ok || line.keptFrom === undefined
    ? "as it was at start"
    : `from the ${clock(line.keptFrom)} run`;
}

function duration({ durationMs }: RunLine): string {
  return `${Math.round(durationMs)} ms`;
}

/** The local time as `HH:MM:SS`. */
function clock(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
