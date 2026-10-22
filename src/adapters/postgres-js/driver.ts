import type { ParameterOrJSON, ReservedSql, Sql } from "postgres";
import type { Driver, Queryable, Session } from "../../runtime/ports/index.ts";
import { hasPostgresJsTypes } from "./value-types.ts";

// Without params, postgres.js switches to the simple protocol unless `simple` is false, which its
// types leave out of UnsafeQueryOptions.
const prepared = { prepare: true, simple: false };

function queryable(connection: ReservedSql | Sql): Queryable {
  return {
    async query(text, params = []) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- postgres.js serializes any param value.
      const values = params as ParameterOrJSON<never>[];
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

/**
 * The caller owns `sql` and ends it. Create it with `postgres(url, { types: postgresJsTypes })`,
 * or rows hold postgres.js's default values for bigint, date, timestamp, and bytea.
 */
export function postgresJsDriver(sql: Sql): Driver {
  if (!hasPostgresJsTypes(sql.options.parsers)) {
    throw new Error(
      "postgresJsDriver needs a client created with postgres(url, { types: postgresJsTypes })",
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
        return await fn(reservedSession(reserved));
      } finally {
        try {
          // Released connections return to the pool still holding their session locks.
          await reserved.unsafe("select pg_advisory_unlock_all()");
        } finally {
          reserved.release();
        }
      }
    },
  };
  return driver;
}
