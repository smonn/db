import { describe, expect, it } from "vitest";
import { nodeFileSystem } from "../../adapters/node/index.ts";
import {
  backendPid,
  untilMigrationLockAttempted,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { acquireMigrationLock } from "../../runtime/internal/index.ts";
import { commit, DevDatabaseLockedError, WatcherLockedError } from "../generate/index.ts";
import { errorOf, useWatchProject } from "./watch.test-helper.ts";

const db = useTestDatabase();
const project = useWatchProject(db);

// The key generate, commit, and reset share, held here as a commit or reset would.
const DEV_LOCK_KEY = "7666632338";

describe("watch and the locks", () => {
  it("refuses a second watcher at start, and the first keeps watching", async () => {
    const first = project.startWatch();
    await first.untilRuns(1);

    const second = project.startWatch();
    await expect(second.watching).rejects.toThrow(WatcherLockedError);

    const run = await first.runAfter(() => project.writeTable("id: c.integer(), name: c.text()"));
    expect(run).toMatchObject({ ok: true });
    expect(second.runs).toStrictEqual([]);
  });

  it("fails a run that overlaps a commit or reset, and commit's writes start a fresh run", async () => {
    const watching = project.startWatch();
    await watching.quiet();

    await db.driver.session(async (holder) => {
      await holder.query(`select pg_advisory_lock(${DEV_LOCK_KEY})`);
      const locked = await watching.runAfter(() =>
        project.writeTable("id: c.integer(), name: c.text()"),
      );
      expect(errorOf(locked)).toBeInstanceOf(DevDatabaseLockedError);
    });
    expect(await project.columnsOfWidgets()).toStrictEqual(["id"]);
    const written = await watching.runAfter(() =>
      project.writeTable("id: c.integer(), label: c.text()"),
    );
    expect(written).toMatchObject({ ok: true, result: { file: "written" } });

    let path = "";
    const committed = await watching.runAfter(async () => {
      ({ path } = await commit({
        driver: db.driver,
        fileSystem: nodeFileSystem(),
        migrations: project.migrations,
        slug: "widgets",
        accept: [],
      }));
    });

    expect(committed.changes).toContain(path);
    expect(committed).toMatchObject({ ok: true, result: { file: "absent", sql: undefined } });
  });

  it("stops a wait for the migrator's lock when the signal aborts, and reports no run", async () => {
    await db.driver.session(async (holder) => {
      await acquireMigrationLock(holder);
      const watching = project.startWatch();
      await untilMigrationLockAttempted(db.driver, {
        holderPid: await backendPid(holder),
      });

      await watching.stop();

      expect(watching.runs).toStrictEqual([]);
      expect(watching.lines).toContain("waiting for the migrator's lock");
    });
  });
});
