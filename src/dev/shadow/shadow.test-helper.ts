import type { Driver } from "../../runtime/ports/index.ts";

/** Whether a database of that name exists on `server`. */
export function databaseExistsOn(server: Driver): (name: string) => Promise<boolean> {
  // Other test files may hold their own Shadow databases on the same server at the same time.
  return async (name) => {
    const { rows } = await server.query("select from pg_database where datname = $1", [name]);
    return rows.length === 1;
  };
}

export async function currentDatabase(driver: Driver): Promise<string> {
  const {
    rows: [row],
  } = await driver.query("select current_database() as name");
  return String(row?.["name"]);
}
