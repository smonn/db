import postgres, { type ParameterOrJSON, type ReservedSql, type Sql } from "postgres";
import type { Driver, Queryable, Session } from "../../runtime/ports/index.ts";
import { formatTimestamp, hasPostgresJsConnection, hasPostgresJsTypes } from "./value-types.ts";

// Without params, postgres.js switches to the simple protocol unless `simple` is false, which its
// types leave out of UnsafeQueryOptions.
const prepared = { prepare: true, simple: false };

const inFailedTransaction = "25P02";
const queryCanceled = "57014";

function queryable(connection: ReservedSql | Sql): Queryable {
  return {
    async query(text, params = []) {
      // postgres.js types a Date param as timestamptz, which Postgres converts to a timestamp in
      // the session's zone. Sent as untyped UTC text, it takes its column's type instead.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- postgres.js serializes any param value.
      const values = params.map((value) =>
        value instanceof Date ? formatTimestamp(value) : value,
      ) as ParameterOrJSON<never>[];
      const result = await connection.unsafe(text, values, prepared);
      return { rows: [...result], count: result.count ?? 0 };
    },
    async execute(script) {
      await connection.unsafe(script).simple();
    },
  };
}

// postgres.js gives a reserved connection no `begin`, so the session sends the statements itself.
function reservedSession(reserved: ReservedSql): Session {
  const session = queryable(reserved);
  return {
    ...session,
    async transaction(fn) {
      await session.execute("begin");
      try {
        const result = await fn(session);
        await session.execute("commit");
        return result;
      } catch (error) {
        await session.execute("rollback");
        throw error;
      }
    },
  };
}

// DISCARD ALL minus DEALLOCATE ALL, which would drop the statements postgres.js caches per
// connection, so a cached statement would fail inside the next transaction on it. RESET ALL keeps
// the startup settings.
const discardAllButStatements =
  "set statement_timeout = 0; reset all; close all; set session authorization default; unlisten *; select pg_advisory_unlock_all(); discard plans; discard temp; discard sequences";

// The backend exits once idle, since postgres.js crashes when a backend ends mid-query (#154).
const endBackendOnceIdle = "set idle_session_timeout = 1";

// A rollback with no open transaction warns, so client_min_messages hides it, and the rollback
// undoes that set. An aborted transaction refuses the set, so it gets the plain rollback.
type AfterRollback = { readonly quiet: string; readonly plain: string };
const quietRollback = "set client_min_messages = error; rollback";
const reset: AfterRollback = {
  quiet: `${quietRollback}; ${discardAllButStatements}`,
  plain: `rollback; ${discardAllButStatements}`,
};
const endBackend: AfterRollback = {
  quiet: `${quietRollback}; ${endBackendOnceIdle}`,
  plain: `rollback; ${endBackendOnceIdle}`,
};

const resetAttempts = 5;

function sqlState(error: unknown): string | undefined {
  return error instanceof postgres.PostgresError ? error.code : undefined;
}

// A FATAL error or a postgres.js connection error means the backend is gone.
function backendAlive(error: unknown): boolean {
  return error instanceof postgres.PostgresError && error.severity === "ERROR";
}

// A leaked statement_timeout governs every statement until the script clears it, so a busy server
// can cancel one, and the run starts again from whatever state the cancel left.
async function afterRollback(
  reserved: ReservedSql,
  scripts: AfterRollback,
  script = scripts.quiet,
  attempt = 1,
): Promise<void> {
  try {
    await reserved.unsafe(script).simple();
  } catch (error) {
    const code = sqlState(error);
    if (attempt === resetAttempts || (code !== inFailedTransaction && code !== queryCanceled)) {
      throw error;
    }
    const next = code === inFailedTransaction ? scripts.plain : scripts.quiet;
    await afterRollback(reserved, scripts, next, attempt + 1);
  }
}

// Releases the connection once it's reset. If the reset fails, the connection never goes back:
// postgres.js crashes on a released connection whose backend has ended. Only when the backend can't
// be ended does it go back, and the reset's error surfaces.
async function returnToPool(reserved: ReservedSql): Promise<void> {
  try {
    await afterRollback(reserved, reset);
  } catch (error) {
    if (backendAlive(error)) {
      await afterRollback(reserved, endBackend).catch(() => {
        reserved.release();
        throw error;
      });
    }
    return;
  }
  reserved.release();
}

/**
 * The caller owns `sql` and ends it. Create it with
 * `postgres(url, { types: postgresJsTypes, connection: postgresJsConnection })`, or rows hold
 * postgres.js's default values, or values in the database's DateStyle and bytea_output.
 */
export function postgresJsDriver(sql: Sql): Driver {
  if (!hasPostgresJsTypes(sql.options.parsers)) {
    throw new Error(
      "postgresJsDriver needs a client created with postgres(url, { types: postgresJsTypes })",
    );
  }
  if (!hasPostgresJsConnection(sql.options.connection)) {
    throw new Error(
      "postgresJsDriver needs a client created with postgres(url, { connection: postgresJsConnection }), which sets DateStyle=ISO and bytea_output=hex",
    );
  }
  const driver: Driver = {
    ...queryable(sql),
    transaction(fn) {
      return driver.session((session) => session.transaction(fn));
    },
    async session(fn) {
      const reserved = await sql.reserve();
      let result;
      try {
        result = await fn(reservedSession(reserved));
      } catch (error) {
        await returnToPool(reserved).catch(() => {});
        throw error;
      }
      await returnToPool(reserved);
      return result;
    },
  };
  return driver;
}
