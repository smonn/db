import { describe, expect, it } from "vitest";
import {
  afterMigrationLockPolled,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

describe("reset and a held migrator's lock", () => {
  it("logs one line while it waits, however many polls the wait takes", async () => {
    await db.driver.execute(
      "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public",
    );
    const lines: string[] = [];

    await afterMigrationLockPolled(db.driver, () =>
      reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: "db/migrations",
        log: (line) => {
          lines.push(line);
        },
      }),
    );

    expect(lines).toStrictEqual(["waiting for the migrator's lock"]);
  });
});
