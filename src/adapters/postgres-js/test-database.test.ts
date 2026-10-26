import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { explainConnectionError, testServerUrl } from "./test-database.test-helper.ts";

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
