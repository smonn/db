import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type { Connect, Driver } from "../../runtime/ports/index.ts";

export type ShadowDatabases = {
  readonly shadow: Driver;
  readonly definition: Driver;
};

/**
 * Creates a fresh Shadow database and Definition database from `template0` over `driver`'s
 * connection, hands `fn` a Driver on each, and drops both when `fn` settles (ADR-0011, ADR-0013).
 */
export function withShadowDatabases<T>(
  driver: Driver,
  connect: Connect,
  fn: (databases: ShadowDatabases) => Promise<T>,
): Promise<T> {
  return withThrowawayDatabase(driver, connect, "smonn_db_shadow_", (shadow) =>
    withThrowawayDatabase(driver, connect, "smonn_db_definition_", (definition) =>
      fn({ shadow, definition }),
    ),
  );
}

async function withThrowawayDatabase<T>(
  driver: Driver,
  connect: Connect,
  prefix: string,
  fn: (database: Driver) => Promise<T>,
): Promise<T> {
  const name = `${prefix}${Math.floor(Date.now() / 1000)}_${randomHex(4)}`;
  await driver.execute(`create database ${quoteIdentifier(name)} template template0`);
  try {
    const connection = await connect(name);
    try {
      return await fn(connection.driver);
    } finally {
      await connection.close();
    }
  } finally {
    await driver.execute(`drop database if exists ${quoteIdentifier(name)} with (force)`);
  }
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
