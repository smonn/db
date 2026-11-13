import { describe, expect, it } from "vitest";
import { CatchUpFailedError, type GeneratedFiles, type GenerateResult } from "../generate/index.ts";
import { runTracker, watchLog, type WatchLogSink } from "./watch-log.ts";
import type { WatchRun } from "./watch.ts";

type GoodRun = Extract<WatchRun, { readonly ok: true }>;
type FailedRun = Extract<WatchRun, { readonly ok: false }>;

const CWD = "/work";
const DROP = 'alter table "public"."users" drop column "nickname";';

/** A local time today, so the expected `HH:MM:SS` doesn't depend on the time zone. */
function at(hours: number, minutes: number, seconds: number): Date {
  return new Date(2026, 10, 13, hours, minutes, seconds);
}

type Logged = {
  readonly out: string[];
  readonly err: string[];
  readonly log: ReturnType<typeof watchLog>;
};

function logged(options: { readonly color?: boolean } = {}): Logged {
  const out: string[] = [];
  const err: string[] = [];
  const sink: WatchLogSink = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    color: options.color === true,
    cwd: CWD,
  };
  return { out, err, log: watchLog(sink) };
}

function files(overrides: { file?: GeneratedFiles["file"]; sql?: string } = {}): GeneratedFiles {
  return {
    path: `${CWD}/migrations/current.sql`,
    file: "kept",
    sql: undefined,
    hazards: [],
    hints: [],
    ...overrides,
  };
}

function good(
  overrides: Partial<GenerateResult> & {
    startedAt: Date;
    changes?: readonly string[];
    durationMs?: number;
  },
): GoodRun {
  const { startedAt, changes = [], durationMs = 148, ...result } = overrides;
  return {
    ok: true,
    changes,
    startedAt,
    durationMs,
    result: { ...files(), devDatabase: { kind: "none" }, ...result },
  };
}

function bad(
  startedAt: Date,
  error: unknown,
  changes: readonly string[] = [`${CWD}/src/users.ts`],
): FailedRun {
  return { ok: false, changes, startedAt, durationMs: 96, error };
}

describe("watchLog", () => {
  it("prints what it watches, then one line for the initial run with its report indented", () => {
    const { out, log } = logged();

    log.watching(`${CWD}/src/definition.ts`, `${CWD}/migrations`);
    log.report(
      good({
        startedAt: at(14, 2, 11),
        durationMs: 301.4,
        file: "written",
        sql: "create table users ();\n",
        devDatabase: { kind: "replayed", files: ["current.sql"], hazards: [] },
      }),
    );

    expect(out).toStrictEqual([
      "watching src/definition.ts and what it imports, and migrations/ (Ctrl-C to stop)",
      "14:02:11 ok initial run (301 ms)",
      "         wrote migrations/current.sql",
      "         replayed current.sql into the Dev database",
    ]);
  });

  it("prints a run's trigger and its Hazards under the line", () => {
    const { out, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    out.length = 0;

    log.report(
      good({
        startedAt: at(14, 2, 40),
        durationMs: 212,
        changes: [`${CWD}/src/db/schema.ts`],
        file: "written",
        sql: `-- hazard: data_loss\n${DROP}\n`,
        devDatabase: {
          kind: "diffed",
          skipped: [],
          hazards: [{ kind: "data_loss", statement: DROP }],
        },
      }),
    );

    expect(out).toStrictEqual([
      "14:02:40 ok src/db/schema.ts changed, 212 ms",
      "         wrote migrations/current.sql",
      `         hazard data_loss: ${DROP}`,
      "         diffed the Dev database to the files",
      `         hazard data_loss in the Dev database: ${DROP}`,
    ]);
  });

  it("prints ok no change for a run that changes nothing", () => {
    const { out, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    out.length = 0;

    log.report(good({ startedAt: at(14, 3, 5), changes: [`${CWD}/src/db/schema.ts`] }));

    expect(out).toStrictEqual(["14:03:05 ok no change src/db/schema.ts changed, 148 ms"]);
  });

  it("names the first path and counts the rest when a burst changed several", () => {
    const { out, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    out.length = 0;

    log.report(
      good({
        startedAt: at(14, 3, 5),
        changes: [`${CWD}/src/a.ts`, `${CWD}/src/b.ts`, `${CWD}/src/c.ts`],
      }),
    );

    expect(out).toStrictEqual(["14:03:05 ok no change src/a.ts and 2 more changed, 148 ms"]);
  });

  it("prints a failed run's error, then which run's Dev database it kept, and ok fixed after", () => {
    const { out, err, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    log.report(good({ startedAt: at(14, 2, 40), file: "written", sql: "select 1;\n" }));
    out.length = 0;

    log.report(
      bad(at(14, 3, 31), new Error("users.ts:14:21 - TypeError\n    at load (schema.ts:3:1)")),
    );

    expect(out).toStrictEqual(["14:03:31 failed src/users.ts changed, 96 ms"]);
    expect(err).toStrictEqual([
      "         users.ts:14:21 - TypeError",
      "             at load (schema.ts:3:1)",
      "         kept the Dev database from the 14:02:40 run",
    ]);

    out.length = 0;
    err.length = 0;
    log.report(
      good({ startedAt: at(14, 3, 52), changes: [`${CWD}/src/users.ts`], durationMs: 231 }),
    );
    expect(out).toStrictEqual(["14:03:52 ok fixed src/users.ts changed, 231 ms"]);
    expect(err).toStrictEqual([]);
  });

  it("keeps naming the last good run through a second failure", () => {
    const { err, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    log.report(bad(at(14, 3, 0), new Error("first")));
    err.length = 0;

    log.report(bad(at(14, 3, 10), new Error("second")));

    expect(err).toStrictEqual([
      "         second",
      "         kept the Dev database from the 14:02:11 run",
    ]);
  });

  it("prints a failed catch-up's file and Hazards before its error", () => {
    const { out, err, log } = logged();
    log.report(good({ startedAt: at(14, 2, 11) }));
    out.length = 0;
    const generated = files({
      file: "written",
      sql: `-- hazard: data_loss\n${DROP}\n`,
    });

    log.report(
      bad(at(14, 3, 31), new CatchUpFailedError(new Error("view depends on column"), generated)),
    );

    expect(out).toStrictEqual([
      "14:03:31 failed src/users.ts changed, 96 ms",
      "         wrote migrations/current.sql",
      `         hazard data_loss: ${DROP}`,
    ]);
    expect(err).toStrictEqual([
      "         view depends on column",
      "         kept the Dev database from the 14:02:11 run",
    ]);
  });

  it("says it kept the Dev database as it was at start when the initial run fails", () => {
    const { out, err, log } = logged();

    log.report(bad(at(14, 2, 11), new Error("no definition"), []));

    expect(out).toStrictEqual(["14:02:11 failed initial run (96 ms)"]);
    expect(err).toStrictEqual([
      "         no definition",
      "         kept the Dev database as it was at start",
    ]);
  });

  it("prints a thrown value that is not an Error as a string", () => {
    const { err, log } = logged();

    log.report(bad(at(14, 2, 11), "boom", []));

    expect(err[0]).toBe("         boom");
  });

  it("prints stopped with its time", () => {
    const { out, log } = logged();

    log.stopped(at(14, 4, 10));

    expect(out).toStrictEqual(["14:04:10 stopped"]);
  });

  it("colors the time, the outcome, and the kept line only when it may", () => {
    const { out, err, log } = logged({ color: true });
    log.report(good({ startedAt: at(14, 2, 11) }));
    log.report(bad(at(14, 3, 31), new Error("bad")));
    log.stopped(at(14, 4, 10));

    expect(out[0]).toBe(
      "\u001B[2m14:02:11\u001B[22m \u001B[32mok\u001B[39m initial run \u001B[2m(148 ms)\u001B[22m",
    );
    expect(out[1]).toBe(
      "\u001B[2m14:03:31\u001B[22m \u001B[31mfailed\u001B[39m \u001B[2msrc/users.ts changed, 96 ms\u001B[22m",
    );
    expect(out[2]).toBe("\u001B[2m14:04:10\u001B[22m stopped");
    expect(err[1]).toBe("         \u001B[33mkept the Dev database from the 14:02:11 run\u001B[39m");
  });
});

describe("runTracker", () => {
  it("is one value per run, with the data a line shows", () => {
    const next = runTracker(CWD);

    const initial = next.good(good({ startedAt: at(14, 2, 11), durationMs: 301 }), true);
    const changed = next.good(
      good({ startedAt: at(14, 2, 40), durationMs: 212, changes: [`${CWD}/src/a.ts`] }),
      false,
    );
    const failed = next.failed(bad(at(14, 3, 31), new Error("x")));
    const fixed = next.good(good({ startedAt: at(14, 3, 52), changes: [`${CWD}/src/a.ts`] }), true);

    expect(initial).toStrictEqual({
      at: at(14, 2, 11),
      ok: true,
      outcome: "initial",
      trigger: [],
      durationMs: 301,
    });
    expect(changed).toMatchObject({ ok: true, outcome: "changed", trigger: ["src/a.ts"] });
    expect(failed).toMatchObject({ ok: false, keptFrom: at(14, 2, 40), trigger: ["src/users.ts"] });
    expect(fixed).toMatchObject({ ok: true, outcome: "fixed" });
  });

  it("calls a good run with nothing to report unchanged", () => {
    const next = runTracker(CWD);
    next.good(good({ startedAt: at(14, 2, 11) }), true);

    expect(next.good(good({ startedAt: at(14, 3, 5) }), true)).toMatchObject({
      outcome: "unchanged",
    });
  });
});
