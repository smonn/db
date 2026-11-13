import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { nodeFileSystem } from "../../adapters/node/index.ts";
import type { TestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { loadDefinitionInWorker } from "./definition-loader.ts";
import { watch, type WatchOptions, type WatchRun } from "./watch.ts";

export const RUNTIME: string = JSON.stringify(
  pathToFileURL(join(import.meta.dirname, "../../runtime/index.ts")).href,
);

/** How long watch must report nothing to count as quiet. */
export const QUIET_FOR_MS = 400;

type Watching = {
  readonly runs: WatchRun[];
  readonly lines: string[];
  readonly watching: Promise<void>;
  /** Waits until `count` runs have reported. */
  untilRuns(count: number): Promise<void>;
  /**
   * Waits for a run, then until every run begun has reported and none begins for a while, and
   * returns how many have. macOS reports a write made just before a watcher started, so the first
   * runs can be more than one.
   */
  quiet(): Promise<number>;
  /** Runs `change` once watch is quiet, and returns the run it causes. */
  runAfter(change: () => Promise<void>): Promise<WatchRun>;
  stop(): Promise<void>;
};

export type WatchProject = {
  /** The project folder, holding `definition.ts`, `tables/widgets.ts`, and `migrations/`. */
  readonly dir: string;
  readonly migrations: string;
  readonly definition: string;
  /** Rewrites `tables/widgets.ts`, which the Definition imports, with these columns. */
  writeTable(columns: string): Promise<void>;
  /** Starts watch on the project; the test's end stops it. */
  startWatch(overrides?: Partial<WatchOptions>): Watching;
  /** The columns of `public.widgets` in the Dev database. */
  columnsOfWidgets(): Promise<string[]>;
};

/** A project with a `widgets` table in a fresh temp folder, and an empty Dev database, per test. */
export function useWatchProject(db: TestDatabase): WatchProject {
  let dir = "";
  const stops: (() => Promise<void>)[] = [];
  const writeTable = (columns: string): Promise<void> => writeWidgets(dir, columns);

  beforeEach(async () => {
    await db.driver.execute(
      "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public",
    );
    // The loader reports real paths, and macOS links the temp folder elsewhere.
    dir = await realpath(await mkdtemp(join(tmpdir(), "smonn-db-watch-")));
    await writeProject(dir);
  });

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    get migrations() {
      return join(dir, "migrations");
    },
    get definition() {
      return join(dir, "definition.ts");
    },
    writeTable,
    startWatch(overrides = {}) {
      const watching = startWatch(db, {
        definition: join(dir, "definition.ts"),
        migrations: join(dir, "migrations"),
        ...overrides,
      });
      stops.push(() => watching.stop().catch(() => {}));
      return watching;
    },
    columnsOfWidgets: () => columnsOfWidgets(db),
  };
}

function writeWidgets(dir: string, columns: string): Promise<void> {
  return writeFile(
    join(dir, "tables/widgets.ts"),
    `import { defineTable } from ${RUNTIME};
export const widgets = defineTable((c) => ({ ${columns} }));
`,
  );
}

async function writeProject(dir: string): Promise<void> {
  await mkdir(join(dir, "tables"));
  await writeWidgets(dir, "id: c.integer()");
  await writeFile(
    join(dir, "definition.ts"),
    `import { defineDatabase } from ${RUNTIME};
import { widgets } from "./tables/widgets.ts";
export default defineDatabase({ public: { widgets } });
`,
  );
}

async function columnsOfWidgets(db: TestDatabase): Promise<string[]> {
  const { rows } = await db.driver.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'widgets' order by ordinal_position",
  );
  return rows.map(({ column_name }) => String(column_name));
}

function startWatch(db: TestDatabase, overrides: Partial<WatchOptions>): Watching {
  const runs: WatchRun[] = [];
  const lines: string[] = [];
  const started = { count: 0 };
  const controller = new AbortController();
  const watching = watch({
    driver: db.driver,
    connect: db.connect,
    fileSystem: nodeFileSystem(),
    definition: "",
    migrations: "",
    trackingSchema: "smonn_db",
    signal: controller.signal,
    log: (line) => {
      lines.push(line);
    },
    // Each run that isn't skipped loads the Definition first, so this counts the runs begun.
    load: (file, options) => {
      started.count += 1;
      return loadDefinitionInWorker(file, options);
    },
    report: (run) => {
      runs.push(run);
    },
    ...overrides,
  });
  return {
    runs,
    lines,
    watching,
    untilRuns: (count) => untilRuns(runs, count),
    quiet: () => quiet(runs, started),
    async runAfter(change) {
      const count = await quiet(runs, started);
      await change();
      await untilRuns(runs, count + 1);
      return runs[count]!;
    },
    async stop() {
      controller.abort();
      await watching;
    },
  };
}

function untilRuns(runs: readonly WatchRun[], count: number): Promise<void> {
  return vi.waitFor(
    () => {
      expect(runs.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 20_000, interval: 20 },
  );
}

/** Waits until every run begun has reported, and none begins for a while. */
async function quiet(
  runs: readonly WatchRun[],
  started: { readonly count: number },
): Promise<number> {
  await untilRuns(runs, 1);
  let seen = -1;
  while (seen !== started.count || runs.length !== started.count) {
    seen = started.count;
    // oxlint-disable-next-line eslint/no-await-in-loop -- each wait checks the count before it.
    await delay(QUIET_FOR_MS);
  }
  return runs.length;
}

/** The error of a run that failed; throws for one that didn't. */
export function errorOf(run: WatchRun | undefined): unknown {
  if (run === undefined || run.ok) throw new Error(`expected a failed run, got ${String(run?.ok)}`);
  return run.error;
}
