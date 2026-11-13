import { relative } from "node:path";
import { Worker } from "node:worker_threads";
import type { CatalogDefinition } from "../catalog/index.ts";

/** What a fresh Worker read from the Definition. Plain data, so it survives `postMessage`. */
export type LoadedDefinition = CatalogDefinition & {
  /** The Definition file and every file it imports outside `node_modules`, as absolute paths. */
  readonly files: readonly string[];
};

export type LoadOptions = {
  /** Ends the Worker and rejects. */
  readonly signal?: AbortSignal | undefined;
  /** Ends the Worker and rejects when it hasn't posted by then, as a Definition that never settles. */
  readonly timeoutMs?: number;
};

const LOAD_TIMEOUT_MS = 10_000;

// The built package can't run the TypeScript source, since Node won't strip types under
// node_modules, so tsdown builds the Worker as its own entry beside the code that starts it.
const WORKER = import.meta.url.endsWith(".ts")
  ? "./definition-worker.ts"
  : "./definition-worker.mjs";

/**
 * Loads the Definition file at `file` in a fresh Worker, since the ESM cache keeps the first import
 * of a file for good (ADR-0014), and returns once the Worker has ended. Nothing carries between
 * calls. A failed load rejects with an error whose `files` holds the module graph resolved so far.
 */
export function loadDefinitionInWorker(
  file: string,
  options: LoadOptions = {},
): Promise<LoadedDefinition> {
  const name = relative(process.cwd(), file);
  if (options.signal?.aborted === true) {
    return Promise.reject(stopped(name, options.signal));
  }
  const worker = new Worker(new URL(WORKER, import.meta.url), { workerData: file });
  return settledLoad(worker, name, options);
}

type LoadingWorker = {
  once(event: "message", listener: (loaded: LoadedDefinition) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
};

/**
 * Settles once `worker` has ended, by the first of its message, its error, the timeout, or the
 * signal. Whatever the Definition does after that, such as a timer that throws, changes nothing.
 */
export function settledLoad(
  worker: LoadingWorker,
  name: string,
  { signal, timeoutMs = LOAD_TIMEOUT_MS }: LoadOptions,
): Promise<LoadedDefinition> {
  return new Promise((resolve, reject) => {
    let settle: (() => void) | undefined;
    const decide = (outcome: () => void): void => {
      settle ??= outcome;
    };
    const end = (error: Error): void => {
      decide(() => {
        reject(error);
      });
      // The Definition may leave a timer or socket open, which would keep the Worker alive.
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      end(new Error(`${name} didn't load within ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = (): void => {
      end(stopped(name, signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (loaded) => {
      decide(() => {
        resolve(loaded);
      });
      void worker.terminate();
    });
    worker.once("error", (error) => {
      decide(() => {
        reject(error);
      });
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (settle === undefined) reject(exited(name, code));
      else settle();
    });
  });
}

function stopped(name: string, signal: AbortSignal | undefined): Error {
  return new Error(`stopped loading ${name}`, { cause: signal?.reason });
}

function exited(name: string, code: number): Error {
  return new Error(
    `The Worker loading ${name} exited with code ${code} before returning its Catalog`,
  );
}
