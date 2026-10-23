import type { TestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { GenerateOptions } from "./generate.ts";

/** The options a `generate` test passes: the test database as the Dev database, migrations in `db/migrations`. */
export function generateOptions(
  db: TestDatabase,
  fileSystem: GenerateOptions["fileSystem"],
  definition: GenerateOptions["definition"],
): GenerateOptions {
  return {
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  };
}
