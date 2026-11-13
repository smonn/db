import { relative } from "node:path";
import { nodeFileSystem } from "../../adapters/node/index.ts";
import { postgresJsConnect } from "../../adapters/postgres-js/index.ts";
import type { Project } from "./project.ts";
import { generateReport } from "./report.ts";
import { ignoreNotice, logToStderr, print, withDriver, type Driver } from "./run.ts";
import { onProcessInterrupt } from "./signals.ts";
import { watch, type WatchRun } from "./watch.ts";

/** `generate --watch`, which prints its own lines until it has events (ADR-0032). */
export type WatchCommand = {
  readonly name: "generate";
  readonly watch: true;
  readonly config: string;
};

export function watchGenerate(project: Project): Promise<void> {
  return withDriver(project, (driver) => runWatch(driver, project));
}

/**
 * Runs `generate --watch` until SIGINT or SIGTERM. The signal aborts a Definition load or lock
 * wait; the process then dies of it, so Postgres rolls back the run's open transaction.
 */
async function runWatch(driver: Driver, project: Project): Promise<void> {
  const controller = new AbortController();
  // One handler for the watch and each run's Shadow cleanup, so the process dies only after all.
  const onInterrupt = onProcessInterrupt();
  const unregister = onInterrupt(() => {
    controller.abort();
    return Promise.resolve();
  });
  try {
    await watch({
      driver,
      connect: postgresJsConnect(project.url, { onnotice: ignoreNotice }),
      fileSystem: nodeFileSystem(),
      definition: project.definitionFile,
      migrations: project.migrationsFolder,
      trackingSchema: project.trackingSchema,
      strict: project.strict === true ? { config: project.configPath } : undefined,
      log: logToStderr,
      onInterrupt,
      signal: controller.signal,
      report: printWatchRun,
    });
  } finally {
    unregister();
  }
}

/** Prints a run's report as one-shot generate does, or its error. */
function printWatchRun(watchRun: WatchRun): void {
  if (watchRun.ok) {
    for (const line of generateReport(
      watchRun.result,
      relative(process.cwd(), watchRun.result.path),
    )) {
      print(line);
    }
    return;
  }
  logToStderr(watchRun.error instanceof Error ? watchRun.error.message : String(watchRun.error));
}
