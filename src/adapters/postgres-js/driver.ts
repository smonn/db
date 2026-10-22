import postgres, { type ParameterOrJSON, type ReservedSql, type Sql } from "postgres";
import type { Driver, Queryable, Session } from "../../runtime/ports/index.ts";
import { formatTimestamp, hasPostgresJsConnection, hasPostgresJsTypes } from "./value-types.ts";

// Without params, postgres.js switches to the simple protocol unless `simple` is false, which its
// types leave out of UnsafeQueryOptions.
const prepared = { prepare: true, simple: false };

const inFailedTransaction = "25P02";

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
// the startup settings, and comes first so a leaked statement_timeout can't cancel the rest.
const discardAllButStatements =
  "reset all; close all; set session authorization default; unlisten *; select pg_advisory_unlock_all(); discard plans; discard temp; discard sequences";

// A rollback with no open transaction warns, so client_min_messages hides it, and the rollback
// undoes that set. An aborted transaction refuses the set.
async function resetSession(reserved: ReservedSql): Promise<void> {
  try {
    await reserved
      .unsafe(`set client_min_messages = error; rollback; ${discardAllButStatements}`)
      .simple();
  } catch (error) {
    if (!(error instanceof postgres.PostgresError) || error.code !== inFailedTransaction) {
      throw error;
    }
    await reserved.unsafe(`rollback; ${discardAllButStatements}`).simple();
  }
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
      try {
        const result = await fn(reservedSession(reserved)).catch(async (error: unknown) => {
          await resetSession(reserved).catch(() => {});
          throw error;
        });
        await resetSession(reserved);
        return result;
      } finally {
        reserved.release();
      }
    },
  };
  return driver;
}
