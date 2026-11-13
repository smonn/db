import { relative } from "node:path";
import {
  failureDocument,
  generateDocument,
  type RunEvent,
  type WatchEvent,
} from "../output/index.ts";
import { generateReport } from "./report.ts";
import { runTracker, type RunLine, type WatchLog } from "./watch-log.ts";

export type WatchEventsSink = {
  /** Prints one line on stdout. */
  readonly out: (line: string) => void;
  readonly cwd: string;
};

/**
 * The NDJSON twin of `watchLog` for `generate --watch --json` (ADR-0032): one event per line on
 * stdout, built from the same `RunLine` the log prints. A failed run's error goes in its event,
 * so stderr keeps only generate's progress lines.
 */
export function watchEvents({ out, cwd }: WatchEventsSink): WatchLog {
  const tracker = runTracker(cwd);
  const emit = (event: WatchEvent): void => {
    out(JSON.stringify(event));
  };
  const displayPath = (path: string): string => relative(cwd, path);
  return {
    watching(definition, migrations) {
      emit({
        event: "started",
        at: new Date().toISOString(),
        definition: displayPath(definition),
        migrations: displayPath(migrations),
      });
    },
    report(run) {
      if (run.ok) {
        const path = displayPath(run.result.path);
        const unchanged = generateReport(run.result, path).length === 0;
        const line = tracker.good(run, unchanged);
        emit({
          ...runBase(line),
          ok: true,
          outcome: line.outcome,
          document: generateDocument(run.result, path),
        });
        return;
      }
      const line = tracker.failed(run);
      emit({
        ...runBase(line),
        ok: false,
        keptFrom: line.keptFrom?.toISOString() ?? null,
        document: failureDocument("generate", run.error, displayPath),
      });
    },
    stopped(at) {
      emit({ event: "stopped", at: at.toISOString() });
    },
  };
}

function runBase(line: RunLine): Pick<RunEvent, "event" | "at" | "trigger" | "durationMs"> {
  return {
    event: "run",
    at: line.at.toISOString(),
    trigger: line.trigger,
    durationMs: Math.round(line.durationMs),
  };
}
