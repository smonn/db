/**
 * Finds the Postgres server the tests use: `DATABASE_URL` when set (CI), else the one
 * `scripts/test-db.ts` wrote to `.env.test`. vitest.config.ts and scripts/check.ts share it.
 */
import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const envFile = fileURLToPath(new URL("../.env.test", import.meta.url));

/** The variables vitest injects into the tests: those of `.env.test`, unless `DATABASE_URL` is set. */
export function testEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  file: string = envFile,
): NodeJS.Dict<string> {
  return processEnv["DATABASE_URL"] === undefined && existsSync(file)
    ? parseEnv(readFileSync(file, "utf8"))
    : {};
}

export function testDatabaseUrl(
  processEnv: NodeJS.ProcessEnv = process.env,
  file: string = envFile,
): string | undefined {
  return processEnv["DATABASE_URL"] ?? testEnv(processEnv, file)["DATABASE_URL"];
}

type Connect = (port: number, host: string) => Pick<Socket, "once" | "setTimeout" | "destroy">;

/** Whether something accepts a TCP connection at the URL's host and port within `timeoutMs`. */
export function isReachable(
  url: string,
  timeoutMs = 2000,
  connect: Connect = createConnection,
): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = connect(Number(target.port === "" ? 5432 : target.port), target.hostname);
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      done(true);
    });
    socket.once("timeout", () => {
      done(false);
    });
    socket.once("error", () => {
      done(false);
    });
  });
}
