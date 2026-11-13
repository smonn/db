import type { FailureDocument, GenerateDocument } from "./document.ts";

/** What a good run did, as the watch log's line says it. */
export type RunOutcome = "initial" | "changed" | "unchanged" | "fixed";

/** The first event, once the watcher lock is held. Both paths are relative to the working directory. */
export type StartedEvent = {
  readonly event: "started";
  /** When watching began, as an ISO 8601 instant. */
  readonly at: string;
  /** The Definition file, whose imports are watched too. */
  readonly definition: string;
  /** The migrations folder. */
  readonly migrations: string;
};

/** The facts every `run` event holds, whether the run ended well or not. */
type RunBase = {
  readonly event: "run";
  /** When the run began, as an ISO 8601 instant. */
  readonly at: string;
  /** The paths whose change started the run, relative to the working directory; empty for the run at start. */
  readonly trigger: readonly string[];
  readonly durationMs: number;
};

/**
 * One run of generate. A good run holds the document `generate --json` prints; a failed one holds
 * the failure document, which for a failed catch-up carries the file and Hazards generate settled.
 */
export type RunEvent = RunBase &
  (
    | {
        readonly ok: true;
        readonly outcome: RunOutcome;
        readonly document: GenerateDocument;
      }
    | {
        readonly ok: false;
        /** When the last good run began, whose Dev database this run keeps; null before one. */
        readonly keptFrom: string | null;
        readonly document: FailureDocument;
      }
  );

/** The last event, on Ctrl-C or SIGTERM. */
export type StoppedEvent = {
  readonly event: "stopped";
  readonly at: string;
};

/** One line of `generate --watch --json`, told apart by `event`. */
export type WatchEvent = StartedEvent | RunEvent | StoppedEvent;
