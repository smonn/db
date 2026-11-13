import { once } from "node:events";
import { statSync, watch as watchDirectory, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { CURRENT_FILENAME, writeCurrent } from "../../runtime/internal/index.ts";
import type { Connect, Driver, FileSystem } from "../../runtime/ports/index.ts";
import { generateFromCatalog, withWatchLock, type GenerateResult } from "../generate/index.ts";
import type { OnInterrupt } from "../shadow/index.ts";
import {
  loadDefinitionInWorker,
  type LoadedDefinition,
  type LoadOptions,
} from "./definition-loader.ts";
import { runLoop } from "./run-loop.ts";

/** One run of `generate --watch`, as `report` receives it. */
export type WatchRun = {
  /** The paths whose change started the run, empty for the run at start. */
  readonly changes: readonly string[];
  readonly startedAt: Date;
  readonly durationMs: number;
} & (
  | { readonly ok: true; readonly result: GenerateResult }
  | { readonly ok: false; readonly error: unknown }
);

export type WatchOptions = {
  /** The Dev database's pool. The watcher lock holds one connection, and each run takes another. */
  readonly driver: Driver;
  readonly connect: Connect;
  readonly fileSystem: FileSystem;
  /** The Definition file, as an absolute path. */
  readonly definition: string;
  /** The migrations folder, as an absolute path. */
  readonly migrations: string;
  readonly trackingSchema: string;
  readonly strict?: { readonly config: string } | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly onInterrupt?: OnInterrupt | undefined;
  /** Stops watching. It ends a Definition load or a lock wait in progress; the rest of a run goes on. */
  readonly signal: AbortSignal;
  /** Called once, when the watcher lock is held and the first run is about to start. */
  readonly onWatching?: (() => void) | undefined;
  /**
   * Receives every run that ends before `signal` aborts, so nothing reports after the caller has
   * announced it stopped. A run in flight at the abort still finishes, but reports nothing.
   */
  readonly report: (run: WatchRun) => void;
  /** Loads the Definition, by default in a fresh Worker. */
  readonly load?: (file: string, options: LoadOptions) => Promise<LoadedDefinition>;
};

// How long the files stay unchanged before a run starts (ADR-0032).
const QUIET_MS = 100;

/** `current.sql`'s content is unknown, so any event on it starts a run. */
const UNKNOWN = Symbol("unknown");

/**
 * Runs generate once, then again after each change to the Definition's module graph or the
 * migrations folder, until `signal` aborts (ADR-0032). Each run loads the Definition in a fresh
 * Worker and takes the Dev and migrator locks for its own length only. A failed run keeps the last
 * good Dev database, and watching goes on. Refuses at start while another watcher holds the
 * watcher lock.
 */
export function watch(options: WatchOptions): Promise<void> {
  return withWatchLock(options.driver, () => watchLocked(options));
}

/** What watch carries from one run to the next. */
type WatchState = {
  /** The files whose folders are watched. */
  files: ReadonlySet<string>;
  /** The module graph an event in those folders must name; unknown until a good load. */
  graph: ReadonlySet<string> | undefined;
  /** What watch's last run left in `current.sql`. */
  written: string | undefined | typeof UNKNOWN;
};

async function watchLocked(options: WatchOptions): Promise<void> {
  const { migrations, signal } = options;
  const state: WatchState = {
    files: new Set([options.definition]),
    graph: undefined,
    written: UNKNOWN,
  };
  const watchers = directoryWatchers((directory, filename) => {
    const path = filename === null ? directory : join(directory, filename);
    // Linux can give a folder made again its old inode number, so the inode alone can't tell.
    if (path === migrations) watchers.forget(migrations);
    if (counts(state, migrations, directory, path)) loop.changed(path);
  });
  // The migrations folder's parent too: a watcher follows the folder's inode on Linux, so only
  // the parent sees the folder deleted and made again, as a checkout can.
  const directories = (): string[] => [
    migrations,
    dirname(migrations),
    ...[...state.files].map((file) => dirname(file)),
  ];
  const run = async (changes: readonly string[]): Promise<void> => {
    await runOnce(options, state, changes);
    if (!signal.aborted) watchers.rebuild(directories());
  };

  watchers.rebuild(directories());
  options.onWatching?.();
  const loop = runLoop({ run, quietMs: QUIET_MS });
  if (!signal.aborted) await once(signal, "abort");
  watchers.close();
  await loop.stop();
}

/**
 * Whether an event at `path` in `directory` starts a run: any event in the migrations folder or
 * on the folder itself, and in a module folder one on a file of the graph, or on any file while
 * the graph is unknown.
 */
function counts(state: WatchState, migrations: string, directory: string, path: string): boolean {
  if (directory === migrations || path === migrations) return true;
  const moduleFolder = [...state.files].some((file) => dirname(file) === directory);
  return moduleFolder && (state.graph === undefined || state.graph.has(path));
}

/** One run: loads the Definition, generates, and reports, unless `changes` are watch's own write. */
async function runOnce(
  options: WatchOptions,
  state: WatchState,
  changes: readonly string[],
): Promise<void> {
  const currentPath = join(options.migrations, CURRENT_FILENAME);
  if (await isOwnWrite(options.fileSystem, currentPath, state.written, changes)) return;
  const startedAt = new Date();
  const started = performance.now();
  const timing = () => ({ changes, startedAt, durationMs: performance.now() - started });
  const before = await options.fileSystem.readFile(currentPath);
  try {
    const loaded = await loadGraph(options, state);
    const result = await generateFromCatalog({ ...generateOptions(options), definition: loaded });
    state.written = await contentAfter(result, before);
    if (!options.signal.aborted) options.report({ ...timing(), ok: true, result });
  } catch (error) {
    state.written = UNKNOWN;
    if (!options.signal.aborted) options.report({ ...timing(), ok: false, error });
  }
}

/** Whether every change is to `current.sql`, which still holds what watch last left there. */
async function isOwnWrite(
  fileSystem: FileSystem,
  currentPath: string,
  written: WatchState["written"],
  changes: readonly string[],
): Promise<boolean> {
  return (
    changes.length > 0 &&
    changes.every((path) => path === currentPath) &&
    written !== UNKNOWN &&
    (await fileSystem.readFile(currentPath)) === written
  );
}

/** Loads the Definition in a fresh Worker and records its module graph in `state`. */
async function loadGraph(options: WatchOptions, state: WatchState): Promise<LoadedDefinition> {
  const { definition, signal, load = loadDefinitionInWorker } = options;
  try {
    const loaded = await load(definition, { signal });
    state.files = state.graph = new Set(loaded.files);
    return loaded;
  } catch (error) {
    // Keep watching an import that broke, so a fix to it starts the next run.
    state.files = new Set([definition, ...filesOf(error)]);
    state.graph = undefined;
    throw error;
  }
}

function generateOptions(options: WatchOptions) {
  const { driver, connect, fileSystem, migrations, trackingSchema, signal } = options;
  return {
    driver,
    connect,
    fileSystem,
    migrations,
    trackingSchema,
    signal,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
  };
}

/** The module graph a failed load resolved before it failed, which its error carries. */
function filesOf(error: unknown): string[] {
  const files: unknown = error instanceof Error ? Reflect.get(error, "files") : undefined;
  return Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
}

/** What `current.sql` holds after a run: what generate wrote, or what it left there. */
async function contentAfter(
  result: GenerateResult,
  before: string | undefined,
): Promise<string | undefined> {
  if (result.file === "removed") return undefined;
  if (result.file === "kept" || result.sql === undefined) return before;
  return (await writeCurrent(result.sql)).content;
}

type DirectoryWatchers = {
  /**
   * Watches each of `directories` that exists and no other. A directory it already watches keeps
   * its watcher, so an event still in flight isn't lost, unless the directory was recreated.
   */
  rebuild(directories: readonly string[]): void;
  /** Drops the watcher on `directory`, so the next rebuild watches it afresh. */
  forget(directory: string): void;
  close(): void;
};

type Watched = { readonly watcher: FSWatcher; readonly inode: number };

/**
 * Non-recursive watchers, one per directory: a recursive watch on Linux goes deaf after a save
 * that renames over the file on Node before 24.22 (#767's research).
 */
function directoryWatchers(
  onEvent: (directory: string, filename: string | null) => void,
): DirectoryWatchers {
  const watched = new Map<string, Watched>();
  const unwatch = (directory: string): void => {
    watched.get(directory)?.watcher.close();
    watched.delete(directory);
  };
  const rewatch = (directory: string): void => {
    // A watcher follows the inode, so a directory deleted and made again needs a new one.
    const inode = statSync(directory, { throwIfNoEntry: false })?.ino;
    if (watched.get(directory)?.inode === inode) return;
    unwatch(directory);
    if (inode === undefined) return;
    const watcher = watchIfPresent(directory, onEvent, () => {
      // A deleted directory can error its watcher; the next run watches it again if it's back.
      if (watched.get(directory)?.watcher === watcher) unwatch(directory);
    });
    if (watcher !== undefined) watched.set(directory, { watcher, inode });
  };
  return {
    rebuild(directories) {
      const wanted = new Set(directories);
      for (const directory of watched.keys()) if (!wanted.has(directory)) unwatch(directory);
      for (const directory of wanted) rewatch(directory);
    },
    forget: unwatch,
    close() {
      for (const directory of watched.keys()) unwatch(directory);
    },
  };
}

function watchIfPresent(
  directory: string,
  onEvent: (directory: string, filename: string | null) => void,
  onError: () => void,
): FSWatcher | undefined {
  try {
    const watcher = watchDirectory(directory, (_event, filename) => {
      onEvent(directory, filename);
    });
    watcher.on("error", onError);
    return watcher;
  } catch {
    return undefined;
  }
}
