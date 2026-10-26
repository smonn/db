import postgres, { type ParameterOrJSON, type ReservedSql, type Sql } from "postgres";
import type { Driver, Queryable, Session } from "../../runtime/ports/index.ts";
import { bindDateParams } from "./date-params.ts";
import { hasPostgresJsConnection, hasPostgresJsTypes } from "./value-types.ts";

// Without params, postgres.js switches to the simple protocol unless `simple` is false, which its
// types leave out of UnsafeQueryOptions.
const prepared = { prepare: true, simple: false };

const inFailedTransaction = "25P02";
const queryCanceled = "57014";

// A FATAL from the server reaches the statement as CONNECTION_CLOSED once the socket closes. A
// socket error reaches it as the plain Node error.
const connectionGone = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

function connectionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && connectionGone.has(String(error.code));
}

type ReservedConnection = {
  readonly statements: Queryable;
  /** Whether a statement on this connection failed because its connection is gone. */
  readonly ended: () => boolean;
};

// postgres.js crashes or never settles on a statement sent to a connection whose backend has ended
// (#154), so once one of its statements fails that way, later ones reject unsent with that error.
// Only the connection's own statements judge this: `fn` may throw a socket error from its own I/O,
// or rethrow another connection's (#221).
function reservedConnection(reserved: ReservedSql): ReservedConnection {
  const connection = queryable(reserved);
  let lost: { readonly error: unknown } | undefined;
  async function send<T>(statement: () => Promise<T>): Promise<T> {
    if (lost !== undefined) {
      throw lost.error;
    }
    try {
      return await statement();
    } catch (error) {
      if (connectionError(error)) {
        lost ??= { error };
      }
      throw error;
    }
  }
  return {
    statements: {
      query: (text, params) => send(() => connection.query(text, params)),
      execute: (script) => send(() => connection.execute(script)),
    },
    ended: () => lost !== undefined,
  };
}

function queryable(connection: ReservedSql | Sql): Queryable {
  return {
    async query(text, params = []) {
      // postgres.js types a Date param as timestamptz, which Postgres converts to a timestamp in
      // the session's zone. Sent as untyped UTC text, it takes its column's type instead.
      const bound = bindDateParams(text, params);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- postgres.js serializes any param value.
      const values = bound.values as ParameterOrJSON<never>[];
      const result = await connection.unsafe(bound.text, values, prepared);
      return { rows: [...result], count: result.count ?? 0 };
    },
    async execute(script) {
      await connection.unsafe(script).simple();
    },
  };
}

// postgres.js gives a reserved connection no `begin`, so the session sends the statements itself.
function reservedSession(connection: ReservedConnection): Session {
  const session = connection.statements;
  return {
    ...session,
    async transaction(fn) {
      await session.execute("begin");
      try {
        const result = await fn(session);
        await session.execute("commit");
        return result;
      } catch (error) {
        if (connection.ended()) {
          throw error;
        }
        try {
          await session.execute("rollback");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "transaction rejected, and its rollback failed",
            { cause: rollbackError },
          );
        }
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
    const next = attempt === resetAttempts ? undefined : retryScript(sqlState(error), scripts);
    if (next === undefined) throw error;
    await afterRollback(reserved, scripts, next, attempt + 1);
  }
}

function retryScript(code: string | undefined, scripts: AfterRollback): string | undefined {
  if (code === inFailedTransaction) return scripts.plain;
  if (code === queryCanceled) return scripts.quiet;
  return undefined;
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
 *
 * A `Date` param, or an array of them, is bound without a type, so Postgres reads it as the
 * type of its column or other operand. Each use of a repeated `$n` is typed on its own, so one
 * `Date` can meet a `timestamp` and a `timestamptz`. Where nothing names a type, such as
 * `$1 - interval '1 hour'`, write the cast: `$1::timestamptz - interval '1 hour'`. That holds for
 * every use of a repeated `$n`: `ts >= $1 and ts < $1 + interval '1 day'` fails, and it works
 * with `$1::timestamptz` on both uses.
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
      const connection = reservedConnection(reserved);
      let result;
      try {
        result = await fn(reservedSession(connection));
      } catch (error) {
        // A recorded-dead connection is never released: postgres.js closes it, and releasing it
        // would hand the dead connection to the next query.
        if (connection.ended()) {
          throw error;
        }
        try {
          await returnToPool(reserved);
        } catch (resetError) {
          throw new AggregateError(
            [error, resetError],
            "session rejected, and its reset failed, so its connection went back to the pool without one",
            { cause: resetError },
          );
        }
        throw error;
      }
      if (!connection.ended()) {
        await returnToPool(reserved);
      }
      return result;
    },
  };
  return driver;
}
