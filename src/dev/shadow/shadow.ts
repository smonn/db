import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type { Connect, Driver } from "../../runtime/ports/index.ts";

export type ShadowDatabases = {
  readonly shadow: Driver;
  readonly definition: Driver;
};

/**
 * Registers `cleanup` to run if the process is interrupted, such as by SIGINT or SIGTERM, and
 * returns the function that unregisters it.
 */
export type OnInterrupt = (cleanup: () => Promise<void>) => () => void;

export type ShadowOptions = {
  /** Receives one line per stale database the start-of-run sweep drops. */
  readonly log?: (line: string) => void;
  readonly onInterrupt?: OnInterrupt;
};

const SHADOW_PREFIX = "smonn_db_shadow_";
const DEFINITION_PREFIX = "smonn_db_definition_";
const STALE_AFTER_SECONDS = 60 * 60;

const CAN_CREATE_DATABASES = `
select current_user as role, rolcreatedb or rolsuper as allowed
from pg_roles where rolname = current_user`;

// Only databases the role could drop, so another role's leftovers don't fail every generate.
// USAGE, not MEMBER: a NOINHERIT member of the owner can't drop its database.
const IDLE_DROPPABLE_DATABASES = `
select d.datname as name from pg_database d
where pg_has_role(d.datdba, 'USAGE')
  and not exists (select from pg_stat_activity a where a.datid = d.oid)`;

/**
 * Creates a fresh Shadow database and Definition database from `template0` over `driver`'s
 * connection, hands `fn` a Driver on each, and drops both when `fn` settles or the process is
 * interrupted. First drops the stale ones a killed run left behind (ADR-0011, ADR-0013).
 */
export async function withShadowDatabases<T>(
  driver: Driver,
  connect: Connect,
  fn: (databases: ShadowDatabases) => Promise<T>,
  options: ShadowOptions = {},
): Promise<T> {
  const { log = () => {}, onInterrupt = () => () => {} } = options;
  await requireCreateDb(driver);
  await sweepStaleDatabases(driver, [SHADOW_PREFIX, DEFINITION_PREFIX], log);
  return withThrowawayDatabase(driver, connect, onInterrupt, SHADOW, (shadow) =>
    withThrowawayDatabase(driver, connect, onInterrupt, DEFINITION, (definition) =>
      fn({ shadow, definition }),
    ),
  );
}

type Throwaway = {
  readonly prefix: string;
  /**
   * Turns `check_function_bodies` on for the current role in the database, which outranks the
   * role's and the database's own setting. It holds for `connect` when that logs in as the same
   * role.
   */
  readonly checkFunctionBodies: boolean;
};

// The Shadow replay checks function bodies whatever the role or database sets (#67).
const SHADOW: Throwaway = { prefix: SHADOW_PREFIX, checkFunctionBodies: true };
const DEFINITION: Throwaway = { prefix: DEFINITION_PREFIX, checkFunctionBodies: false };

async function requireCreateDb(driver: Driver): Promise<void> {
  const {
    rows: [row],
  } = await driver.query(CAN_CREATE_DATABASES);
  if (row?.["allowed"] === true) return;
  throw new Error(
    `generate creates its Shadow database, so role ${quoteIdentifier(String(row?.["role"]))} needs CREATEDB`,
  );
}

/**
 * Drops each database named `<prefix><unix seconds>_<8 hex>` whose name is over an hour old and
 * that has no sessions, so a concurrent run's live database survives.
 */
export async function sweepStaleDatabases(
  driver: Driver,
  prefixes: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  const { rows } = await driver.query(IDLE_DROPPABLE_DATABASES);
  const stale = rows
    .map(({ name }) => String(name))
    .filter((database) => {
      const prefix = prefixes.find((candidate) => database.startsWith(candidate));
      if (prefix === undefined) return false;
      const seconds = /^(\d+)_[0-9a-f]{8}$/u.exec(database.slice(prefix.length))?.[1];
      return seconds !== undefined && Number(seconds) < cutoff;
    });
  await Promise.all(
    stale.map(async (database) => {
      await dropDatabase(driver, database);
      log(`dropped stale database ${quoteIdentifier(database)}`);
    }),
  );
}

async function withThrowawayDatabase<T>(
  driver: Driver,
  connect: Connect,
  onInterrupt: OnInterrupt,
  { prefix, checkFunctionBodies }: Throwaway,
  fn: (database: Driver) => Promise<T>,
): Promise<T> {
  const name = `${prefix}${Math.floor(Date.now() / 1000)}_${randomHex(4)}`;
  // Registered before the create, so an interrupt during it waits for the create, then drops.
  const created = Promise.withResolvers<void>();
  const unregister = onInterrupt(async () => {
    await created.promise;
    await dropDatabase(driver, name);
  });
  try {
    await driver
      .execute(`create database ${quoteIdentifier(name)} template template0`)
      .finally(() => {
        created.resolve();
      });
    if (checkFunctionBodies) {
      await driver.execute(
        `alter role current_user in database ${quoteIdentifier(name)} set check_function_bodies = on`,
      );
    }
    const connection = await connect(name);
    try {
      return await fn(connection.driver);
    } finally {
      await connection.close();
    }
  } finally {
    unregister();
    await dropDatabase(driver, name);
  }
}

function dropDatabase(driver: Driver, name: string): Promise<void> {
  return driver.execute(`drop database if exists ${quoteIdentifier(name)} with (force)`);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
