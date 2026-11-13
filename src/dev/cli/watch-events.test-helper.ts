import { type GeneratedFiles, type GenerateResult } from "../generate/index.ts";
import { watchEvents } from "./watch-events.ts";
import type { WatchRun } from "./watch.ts";

export const CWD = "/work";
export const DROP = 'alter table "public"."users" drop column "nickname";';

export function files(overrides: Partial<GeneratedFiles> = {}): GeneratedFiles {
  return {
    path: `${CWD}/migrations/current.sql`,
    file: "kept",
    sql: undefined,
    hazards: [],
    hints: [],
    ...overrides,
  };
}

export function good(
  startedAt: Date,
  changes: readonly string[],
  result: Partial<GenerateResult> = {},
): WatchRun {
  return {
    ok: true,
    changes,
    startedAt,
    durationMs: 148,
    result: { ...files(), devDatabase: { kind: "none" }, ...result },
  };
}

export function bad(startedAt: Date, error: unknown): WatchRun {
  return { ok: false, changes: [`${CWD}/src/users.ts`], startedAt, durationMs: 96, error };
}

/** Runs `session` against a fresh emitter and parses each line it printed, as a script would. */
export function session(play: (log: ReturnType<typeof watchEvents>) => void): {
  lines: string[];
  events: Record<string, unknown>[];
} {
  const lines: string[] = [];
  play(
    watchEvents({
      out: (line) => {
        lines.push(line);
      },
      cwd: CWD,
    }),
  );
  return { lines, events: lines.map((line) => parseEvent(line)) };
}

/** Parses a line as a script would, so the test reads the shape and not the type. */
function parseEvent(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`not an event: ${line}`);
  return Object.fromEntries(Object.entries(parsed));
}

export const T1: Date = new Date("2026-11-13T14:02:11.000Z");
export const T2: Date = new Date("2026-11-13T14:02:40.000Z");
export const T3: Date = new Date("2026-11-13T14:03:31.000Z");
export const T4: Date = new Date("2026-11-13T14:03:52.000Z");
export const T5: Date = new Date("2026-11-13T14:04:30.000Z");
export const STOP: Date = new Date("2026-11-13T14:05:00.000Z");
