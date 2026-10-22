import postgres, { type Options } from "postgres";
import type { Connect } from "../../runtime/ports/index.ts";
import { postgresJsDriver } from "./driver.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

/**
 * Connects to another database on `url`'s server. postgres.js takes the `database` option over
 * the URL's path, which it doesn't percent-decode, so any name works. It sends
 * `postgresJsConnection` under the caller's `connection`, so pass `DateStyle: "ISO, DMY"` to keep
 * a database's DMY order for raw SQL date input; the driver refuses a style other than ISO.
 */
export function postgresJsConnect(
  url: string,
  options: Omit<Options<Record<string, never>>, "types"> = {},
): Connect {
  return (database) => {
    const sql = postgres(url, {
      ...options,
      database,
      types: postgresJsTypes,
      connection: { ...postgresJsConnection, ...options.connection },
    });
    return Promise.resolve({ driver: postgresJsDriver(sql), close: () => sql.end() });
  };
}
