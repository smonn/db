import { nodeFileSystem } from "../../adapters/node/index.ts";
import { postgresJsConnect } from "../../adapters/postgres-js/index.ts";
import type { Project } from "./project.ts";
import { ignoreNotice, logToStderr, print, withDriver, type Driver } from "./run.ts";
import { onProcessInterrupt } from "./signals.ts";
import { watch } from "./watch.ts";
import { watchLog } from "./watch-log.ts";

/** `generate --watch`, which prints a log of its own until it has events (ADR-0032). */
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
  const log = watchLog({
    out: print,
    err: logToStderr,
    color: process.stdout.isTTY && process.stderr.isTTY && process.env["NO_COLOR"] === undefined,
    cwd: process.cwd(),
  });
  // One handler for the watch and each run's Shadow cleanup, so the process dies only after all.
  const onInterrupt = onProcessInterrupt();
  const unregister = onInterrupt(() => {
    log.stopped(new Date());
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
      onWatching: () => {
        log.watching(project.definitionFile, project.migrationsFolder);
      },
      report: (run) => {
        log.report(run);
      },
    });
  } finally {
    unregister();
  }
}
