import { describe, expect, it } from "vitest";
import { CatchUpFailedError } from "../generate/index.ts";
import {
  bad,
  CWD,
  DROP,
  files,
  good,
  session,
  STOP,
  T1,
  T2,
  T3,
  T4,
  T5,
} from "./watch-events.test-helper.ts";

describe("watchEvents", () => {
  it("prints one parseable line per event for a session with good runs, failed runs, and a stop", () => {
    const { lines, events } = session((log) => {
      log.watching(`${CWD}/src/definition.ts`, `${CWD}/migrations`);
      log.report(
        good(T1, [], {
          file: "written",
          sql: "create table users ();\n",
          devDatabase: { kind: "replayed", files: ["current.sql"], hazards: [] },
        }),
      );
      log.report(
        good(T2, [`${CWD}/src/db/schema.ts`], {
          file: "written",
          sql: `-- hazard: data_loss\n${DROP}\n`,
          devDatabase: {
            kind: "diffed",
            skipped: [],
            hazards: [{ kind: "data_loss", statement: DROP }],
          },
        }),
      );
      log.report(bad(T3, new Error("users.ts:14:21 - TypeError")));
      log.report(good(T4, [`${CWD}/src/users.ts`, `${CWD}/src/a.ts`]));
      log.report(good(T5, [`${CWD}/src/users.ts`]));
      log.stopped(STOP);
    });

    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(events.map((event) => event["event"])).toStrictEqual([
      "started",
      "run",
      "run",
      "run",
      "run",
      "run",
      "stopped",
    ]);
    expect(events[0]).toMatchObject({
      event: "started",
      definition: "src/definition.ts",
      migrations: "migrations",
    });
    expect(events[1]).toStrictEqual({
      event: "run",
      at: "2026-11-13T14:02:11.000Z",
      trigger: [],
      durationMs: 148,
      ok: true,
      outcome: "initial",
      document: {
        command: "generate",
        ok: true,
        file: { path: "migrations/current.sql", action: "written", handEdited: false },
        hazards: [],
        hints: [],
        devDatabase: { kind: "replayed", files: ["current.sql"], hazards: [] },
      },
    });
    expect(events[2]).toMatchObject({
      ok: true,
      outcome: "changed",
      trigger: ["src/db/schema.ts"],
      document: {
        hazards: [{ kind: "data_loss", statement: DROP }],
        devDatabase: { kind: "diffed", hazards: [{ kind: "data_loss", statement: DROP }] },
      },
    });
    expect(events[3]).toStrictEqual({
      event: "run",
      at: "2026-11-13T14:03:31.000Z",
      trigger: ["src/users.ts"],
      durationMs: 96,
      ok: false,
      keptFrom: "2026-11-13T14:02:40.000Z",
      document: {
        command: "generate",
        ok: false,
        error: { code: "failed", message: "users.ts:14:21 - TypeError" },
      },
    });
    expect(events[4]).toMatchObject({
      ok: true,
      outcome: "fixed",
      trigger: ["src/users.ts", "src/a.ts"],
    });
    expect(events[5]).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(events[6]).toStrictEqual({ event: "stopped", at: "2026-11-13T14:05:00.000Z" });
  });

  it("holds a failed catch-up's file and Hazards in the failed run's document", () => {
    const generated = files({ file: "written", sql: `-- hazard: data_loss\n${DROP}\n` });
    const { events } = session((log) => {
      log.report(good(T1, []));
      log.report(bad(T2, new CatchUpFailedError(new Error("replay failed"), generated)));
    });

    expect(events[1]).toMatchObject({
      event: "run",
      ok: false,
      keptFrom: "2026-11-13T14:02:11.000Z",
      document: {
        command: "generate",
        ok: false,
        error: {
          code: "catch_up_failed",
          message: "replay failed",
          generated: {
            file: { path: "migrations/current.sql", action: "written", handEdited: false },
            hazards: [{ kind: "data_loss", statement: DROP }],
          },
        },
      },
    });
  });

  it("names no kept run when the first run fails", () => {
    const { events } = session((log) => {
      log.report(bad(T1, new Error("boom")));
    });

    expect(events[0]).toMatchObject({ ok: false, keptFrom: null });
  });
});
