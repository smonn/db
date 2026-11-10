import { relative } from "node:path";
import { Worker } from "node:worker_threads";
import type { Catalog } from "../catalog/index.ts";

/** What a fresh Worker read from the Definition. Plain data, so it survives `postMessage`. */
export type LoadedDefinition = {
  readonly catalog: Catalog;
  readonly schemas: readonly string[];
  /** The Definition file and every file it imports outside `node_modules`, as absolute paths. */
  readonly files: readonly string[];
};

/**
 * Loads the Definition file at `file` in a fresh Worker, since the ESM cache keeps the first import
 * of a file for good (ADR-0014), and returns once the Worker has ended. Nothing carries between
 * calls.
 */
export function loadDefinitionInWorker(file: string): Promise<LoadedDefinition> {
  const worker = new Worker(new URL("./definition-worker.ts", import.meta.url), {
    workerData: file,
  });
  return new Promise((resolve, reject) => {
    let settle = (code: number): void => {
      reject(
        new Error(
          `The Worker loading ${relative(process.cwd(), file)} exited with code ${code} before returning its Catalog`,
        ),
      );
    };
    worker.once("message", (loaded: LoadedDefinition) => {
      settle = () => {
        resolve(loaded);
      };
      // The Definition may leave a timer or socket open, which would keep the Worker alive.
      void worker.terminate();
    });
    worker.once("error", (error: Error) => {
      settle = () => {
        reject(error);
      };
    });
    worker.once("exit", (code: number) => {
      settle(code);
    });
  });
}
