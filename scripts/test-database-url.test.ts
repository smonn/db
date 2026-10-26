import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isReachable, testDatabaseUrl, testEnv } from "./test-database-url.ts";

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "test-database-url-"));
  file = join(dir, ".env.test");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("DATABASE_URL wins over .env.test, which is then not read into the tests", () => {
  writeFileSync(file, "DATABASE_URL=postgres://file/db\n");
  const processEnv = { DATABASE_URL: "postgres://env/db" };
  expect(testDatabaseUrl(processEnv, file)).toBe("postgres://env/db");
  expect(testEnv(processEnv, file)).toEqual({});
});

test("without DATABASE_URL the url and env come from .env.test", () => {
  writeFileSync(file, "DATABASE_URL=postgres://file/db\n");
  expect(testDatabaseUrl({}, file)).toBe("postgres://file/db");
  expect(testEnv({}, file)).toEqual({ DATABASE_URL: "postgres://file/db" });
});

test("an empty DATABASE_URL counts as unset", () => {
  writeFileSync(file, "DATABASE_URL=postgres://file/db\n");
  const processEnv = { DATABASE_URL: "" };
  expect(testDatabaseUrl(processEnv, file)).toBe("postgres://file/db");
  expect(testEnv(processEnv, file)).toEqual({ DATABASE_URL: "postgres://file/db" });
});

test("an empty DATABASE_URL line in .env.test counts as unset", () => {
  writeFileSync(file, "DATABASE_URL=\n");
  expect(testDatabaseUrl({}, file)).toBeUndefined();
  expect(testEnv({}, file)).toEqual({ DATABASE_URL: "" });
});

test("without DATABASE_URL or .env.test there is no url", () => {
  expect(testDatabaseUrl({}, file)).toBeUndefined();
  expect(testDatabaseUrl({ DATABASE_URL: "" }, file)).toBeUndefined();
  expect(testEnv({}, file)).toEqual({});
});

async function listen() {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return {
    url: `postgres://u:p@127.0.0.1:${address.port}/db`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

test("isReachable is true for a listening server and false once it is closed", async () => {
  const { url, close } = await listen();
  expect(await isReachable(url)).toBe(true);
  await close();
  expect(await isReachable(url)).toBe(false);
});

test("isReachable is false for a url it cannot parse", async () => {
  expect(await isReachable("not a url")).toBe(false);
});

const timeouts: number[] = [];

class Silent extends Socket {
  override setTimeout(ms: number) {
    timeouts.push(ms);
    queueMicrotask(() => {
      this.emit("timeout");
    });
    return this;
  }
}

test("isReachable gives up after its timeout and defaults to port 5432", async () => {
  timeouts.length = 0;
  const dialed: unknown[] = [];
  const reachable = await isReachable("postgres://db.invalid/db", 50, (...args) => {
    dialed.push(args);
    return new Silent();
  });
  expect(reachable).toBe(false);
  expect(timeouts).toEqual([50]);
  expect(dialed).toEqual([[5432, "db.invalid"]]);
});

test("isReachable dials an IPv6 literal host without its brackets", async () => {
  const dialed: unknown[] = [];
  await isReachable("postgres://u@[::1]:5433/db", 50, (...args) => {
    dialed.push(args);
    return new Silent();
  });
  expect(dialed).toEqual([[5433, "::1"]]);
});
