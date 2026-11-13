import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { nodeFileSystem } from "../../adapters/node/index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { errorOf, QUIET_FOR_MS, RUNTIME, useWatchProject } from "./watch.test-helper.ts";

const db = useTestDatabase();
const project = useWatchProject(db);

describe("watch", () => {
  it("runs at start, then after a change to a module the Definition imports", async () => {
    const watching = project.startWatch();
    await watching.untilRuns(1);
    expect(watching.runs[0]).toMatchObject({ ok: true, changes: [] });
    expect(await project.columnsOfWidgets()).toStrictEqual(["id"]);

    const run = await watching.runAfter(() =>
      project.writeTable("id: c.integer(), name: c.text()"),
    );

    expect(run).toMatchObject({ ok: true, changes: [join(project.dir, "tables/widgets.ts")] });
    expect(await project.columnsOfWidgets()).toStrictEqual(["id", "name"]);
  });

  it("reports no run that ends after the signal aborts, though the run still finishes", async () => {
    const stopping: Promise<void>[] = [];
    const real = nodeFileSystem();
    const watching = project.startWatch({
      // The abort lands once generate holds its locks and has written current.sql.
      fileSystem: {
        ...real,
        async writeFile(path, content) {
          await real.writeFile(path, content);
          stopping.push(watching.stop());
        },
      },
    });
    await watching.watching;
    await Promise.all(stopping);

    expect(watching.runs).toStrictEqual([]);
    expect(await project.columnsOfWidgets()).toStrictEqual(["id"]);
  });

  it("calls onWatching once, before the first run reports", async () => {
    const events: string[] = [];

    project.startWatch({
      onWatching: () => {
        events.push("watching");
      },
      report: () => {
        events.push("report");
      },
    });
    await vi.waitFor(
      () => {
        expect(events).toContain("report");
      },
      { timeout: 20_000, interval: 20 },
    );

    expect(events.slice(0, 2)).toStrictEqual(["watching", "report"]);
    expect(events.filter((event) => event === "watching")).toHaveLength(1);
  });

  it("skips the event of its own write to current.sql, and runs on someone else's", async () => {
    const watching = project.startWatch();

    const run = await watching.runAfter(() =>
      project.writeTable("id: c.integer(), name: c.text()"),
    );
    expect(run).toMatchObject({ ok: true, result: { file: "written" } });
    const count = watching.runs.length;
    await delay(QUIET_FOR_MS);
    expect(watching.runs).toHaveLength(count);

    const current = join(project.migrations, "current.sql");
    const edited = await watching.runAfter(async () => {
      await writeFile(current, `${await readFile(current, "utf8")}-- note\n`);
    });
    expect(edited).toMatchObject({ ok: true, changes: [current] });
  });

  it("keeps the last good Dev database after a failed run, and the next good run recovers", async () => {
    const watching = project.startWatch();

    const failed = await watching.runAfter(() =>
      writeFile(join(project.dir, "tables/widgets.ts"), "export const widgets = ;\n"),
    );
    expect(String(errorOf(failed))).toContain("tables/widgets.ts: Expression expected");
    expect(await project.columnsOfWidgets()).toStrictEqual(["id"]);

    const fixed = await watching.runAfter(() =>
      project.writeTable("id: c.integer(), name: c.text()"),
    );
    expect(fixed).toMatchObject({ ok: true });
    expect(await project.columnsOfWidgets()).toStrictEqual(["id", "name"]);
  });

  it("watches the migrations folder again once it is deleted and made again", async () => {
    const watching = project.startWatch();
    await watching.untilRuns(1);
    const current = join(project.migrations, "current.sql");
    const content = await readFile(current, "utf8");

    await watching.runAfter(async () => {
      await rm(project.migrations, { recursive: true });
      await mkdir(project.migrations);
      await writeFile(current, content);
    });
    const edited = await watching.runAfter(() => writeFile(current, `${content}-- note\n`));

    expect(edited).toMatchObject({ ok: true, changes: [current] });
  });

  it("ignores a file outside the module graph in a folder it watches", async () => {
    const watching = project.startWatch();
    const count = await watching.quiet();

    await writeFile(join(project.dir, "tables/notes.md"), "notes\n");
    await delay(QUIET_FOR_MS);

    expect(watching.runs).toHaveLength(count);
  });

  it("runs when an import that failed to resolve appears", async () => {
    const watching = project.startWatch();

    const failed = await watching.runAfter(() =>
      writeFile(
        project.definition,
        `import { defineDatabase } from ${RUNTIME};
import { widgets } from "./tables/gadgets.ts";
export default defineDatabase({ public: { widgets } });
`,
      ),
    );
    expect(String(errorOf(failed))).toContain("gadgets.ts");

    const fixed = await watching.runAfter(() =>
      writeFile(
        join(project.dir, "tables/gadgets.ts"),
        `import { defineTable } from ${RUNTIME};
export const widgets = defineTable((c) => ({ id: c.integer(), size: c.integer() }));
`,
      ),
    );
    expect(fixed).toMatchObject({ ok: true });
    expect(await project.columnsOfWidgets()).toStrictEqual(["id", "size"]);
  });
});
