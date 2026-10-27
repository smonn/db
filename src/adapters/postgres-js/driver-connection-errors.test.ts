import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../../runtime/ports/index.ts";
import { postgresJsDriver } from "./driver.ts";
import { testServerUrl, useTestDatabase } from "./test-database.test-helper.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

const db = useTestDatabase();

// A statement the stand-in rejects: the ones `matches` accepts, `times` times, with `error`.
type Rule = {
  readonly matches: (text: string) => boolean;
  readonly error: unknown;
  times: number;
};

const lost = "select 'lost'";
const quietEnd = "set client_min_messages = error; rollback; set idle_session_timeout = 1";
const plainEnd = "rollback; set idle_session_timeout = 1";
const isLost = (text: string): boolean => text === lost;
const endsBackend = (text: string): boolean => text.includes("idle_session_timeout");
const resetsSession = (text: string): boolean => text.includes("discard plans");

function rule(matches: (text: string) => boolean, error: unknown, times = Infinity): Rule {
  return { matches, error, times };
}

/** A real error from the server, with the severity and SQLSTATE a test needs it to carry. */
async function serverError(severity: string, code = "22012"): Promise<postgres.PostgresError> {
  const error = await db.driver.query("select 1 / 0").catch((caught: unknown) => caught);
  if (!(error instanceof postgres.PostgresError)) throw new Error("expected a PostgresError");
  return Object.assign(error, { severity, code });
}

// Statements go to the server unless a rule rejects them, so the driver's own decisions show in
// what it sent.
describe("postgresJsDriver when a statement is rejected with an error of the test's choosing", () => {
  let sql: Sql;
  let driver: Driver;
  let sent: string[] = [];
  let rules: Rule[] = [];
  const held: { release: () => void }[] = [];
  const sentThat = (matches: (text: string) => boolean): string[] =>
    sent.filter((text) => matches(text));

  beforeAll(() => {
    const url = new URL(testServerUrl());
    url.pathname = `/${db.name}`;
    sql = postgres(url.href, {
      max: 1,
      onnotice: () => {},
      types: postgresJsTypes,
      connection: postgresJsConnection,
    });
    const reserve = sql.reserve.bind(sql);
    vi.spyOn(sql, "reserve").mockImplementation(async () => {
      const reserved = await reserve();
      held.push(reserved);
      const release = reserved.release.bind(reserved);
      let released = false;
      // The test releases what the driver kept, and a second release would corrupt the pool.
      vi.spyOn(reserved, "release").mockImplementation(() => {
        if (!released) release();
        released = true;
      });
      const unsafe = reserved.unsafe.bind(reserved);
      vi.spyOn(reserved, "unsafe").mockImplementation((text, ...rest) => {
        sent.push(text);
        const matched = rules.find((candidate) => candidate.times > 0 && candidate.matches(text));
        if (matched === undefined) {
          // A backend that ended would leave the one-connection pool unable to hand out another.
          return unsafe(endsBackend(text) ? "rollback" : text, ...rest);
        }
        matched.times -= 1;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a thrown non-Error is a case under test.
        const rejected = Promise.reject(matched.error);
        // The driver runs a script with `.simple()`, which the rejection stands in for too.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in for postgres.js's PendingQuery.
        return Object.assign(rejected, { simple: () => rejected }) as never;
      });
      return reserved;
    });
    driver = postgresJsDriver(sql);
  });
  afterAll(() => sql.end());
  beforeEach(() => {
    sent = [];
    rules = [];
  });
  afterEach(() => {
    for (const reserved of held.splice(0)) reserved.release();
  });

  it("keeps a session usable after one of its statements fails", async () => {
    const rows = await driver.session(async (session) => {
      await expect(session.query("select 1 / 0")).rejects.toThrow("division by zero");
      return (await session.query("select 1 as one")).rows;
    });
    expect(rows).toStrictEqual([{ one: 1 }]);
  });

  it.each(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "ECONNRESET", "EPIPE", "ETIMEDOUT"])(
    "rejects a later statement with a %s without sending it",
    async (code) => {
      const lostError = Object.assign(new Error(`connection lost: ${code}`), { code });
      rules = [rule(isLost, lostError)];
      const later = await driver.session(async (session) => {
        await session.query(lost).catch(() => null);
        return session.query("select 1").catch((error: unknown) => error);
      });
      expect(later).toBe(lostError);
      expect(sent).toStrictEqual([lost]);
    },
  );

  it.each([
    ["an Error with another code", Object.assign(new Error("denied"), { code: "EACCES" })],
    ["an Error with no code", new Error("failed")],
    ["a thrown object that isn't an Error", { code: "EPIPE" }],
  ])("sends a later statement after %s", async (_name, error) => {
    rules = [rule(isLost, error)];
    await driver.session(async (session) => {
      await session.query(lost).catch(() => null);
      await session.query("select 1");
    });
    expect(sent).toContain("select 1");
  });

  it("ends the backend of a connection whose reset failed with an ERROR", async () => {
    rules = [rule(resetsSession, await serverError("ERROR"))];
    await driver.session(() => Promise.resolve());
    expect(sentThat(endsBackend)).toStrictEqual([quietEnd]);
  });

  it("ends the backend with a plain rollback when the connection is in an aborted transaction", async () => {
    rules = [
      rule(resetsSession, await serverError("ERROR")),
      rule((text) => text === quietEnd, await serverError("ERROR", "25P02")),
    ];
    await driver.session(() => Promise.resolve());
    expect(sentThat(endsBackend)).toStrictEqual([quietEnd, plainEnd]);
  });

  it("gives up on a reset that is cancelled five times, and ends the backend", async () => {
    rules = [rule(resetsSession, await serverError("ERROR", "57014"), 5)];
    await driver.session(() => Promise.resolve());
    expect(sentThat(resetsSession)).toHaveLength(5);
    expect(sentThat(endsBackend)).toStrictEqual([quietEnd]);
  });

  it("leaves a connection whose reset failed with a FATAL error alone", async () => {
    rules = [rule(resetsSession, await serverError("FATAL", "57P01"))];
    await driver.session(() => Promise.resolve());
    expect(sentThat(endsBackend)).toStrictEqual([]);
  });

  it("leaves a connection alone when its reset failed with an error that isn't from the server", async () => {
    rules = [rule(resetsSession, Object.assign(new Error("x"), { severity: "ERROR" }))];
    await driver.session(() => Promise.resolve());
    expect(sentThat(endsBackend)).toStrictEqual([]);
  });
});
