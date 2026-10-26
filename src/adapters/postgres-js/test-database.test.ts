import { setImmediate } from "node:timers/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  explainConnectionError,
  testServerUrl,
  useTestDatabase,
  whileMigrationLockHeld,
} from "./test-database.test-helper.ts";

const db = useTestDatabase();

async function unhandledRejectionsDuring(run: () => Promise<unknown>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    await run().catch(() => {});
    await setImmediate();
  } finally {
    process.off("unhandledRejection", record);
  }
  return reasons;
}

async function connectError(url: string): Promise<unknown> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await sql.end();
  }
}

describe("explainConnectionError", () => {
  it("names DATABASE_URL's host and port when the server rejects the login", async () => {
    const url = new URL(testServerUrl());
    url.password = "wrong-password";
    const error = await connectError(url.href);

    expect(explainConnectionError(error, url.href)).toStrictEqual(
      new Error(
        `DATABASE_URL's server at ${url.host} rejected the login (password authentication failed for user "${url.username}"); another server may hold that port`,
        { cause: error },
      ),
    );
  });

  it("passes other errors through unchanged", () => {
    const error = new Error("boom");
    expect(explainConnectionError(error, "postgres://localhost:54318/postgres")).toBe(error);
  });
});

const failing = (): Promise<never> => Promise.reject(new Error("contender failed"));

describe("whileMigrationLockHeld", () => {
  it("rejects with the contender's error", async () => {
    await expect(whileMigrationLockHeld(db.driver, failing)).rejects.toThrow("contender failed");
  });

  it("leaves no unhandled rejection when the contender rejects while the lock is held", async () => {
    const reasons = await unhandledRejectionsDuring(() =>
      whileMigrationLockHeld(db.driver, failing),
    );

    expect(reasons).toStrictEqual([]);
  });
});
