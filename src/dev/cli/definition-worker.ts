// The Worker entry `loadDefinitionInWorker` starts. It loads one Definition, posts what it read,
// and ends.
import { registerHooks } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { definitionCatalog, definitionSchemas } from "../catalog/index.ts";
import type { LoadedDefinition } from "./definition-loader.ts";
import { definitionOf, importDefault } from "./project.ts";

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window: it takes no target origin.
parentPort?.postMessage(await load(String(workerData)));

async function load(file: string): Promise<LoadedDefinition> {
  const files = new Set<string>();
  // Registered after this file's own imports, so it sees only the Definition's module graph.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("file:") && !resolved.url.includes("/node_modules/")) {
        files.add(fileURLToPath(resolved.url));
      }
      return resolved;
    },
  });
  try {
    const definition = definitionOf(file, await importNamingFile(file));
    return {
      catalog: definitionCatalog(definition),
      schemas: definitionSchemas(definition),
      files: [...files],
    };
  } catch (error) {
    // Watch keeps watching a new import that broke, so a fix to it starts the next run.
    throw error instanceof Error ? Object.assign(error, { files: [...files] }) : error;
  }
}

async function importNamingFile(file: string): Promise<unknown> {
  try {
    return await importDefault(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${relative(process.cwd(), file)}: ${message}`, { cause: error });
  }
}
