import postgres, { type Options } from "postgres";
import type { Connect } from "../../runtime/ports/index.ts";
import { postgresJsDriver } from "./driver.ts";
import { postgresJsTypes } from "./value-types.ts";

/**
 * Connects to another database on `url`'s server. postgres.js takes the `database` option over
 * the URL's path, which it doesn't percent-decode, so any name works.
 */
export function postgresJsConnect(
  url: string,
  options: Omit<Options<Record<string, never>>, "types"> = {},
): Connect {
  return (database) => {
    const sql = postgres(url, { ...options, database, types: postgresJsTypes });
    return Promise.resolve({ driver: postgresJsDriver(sql), close: () => sql.end() });
  };
}
