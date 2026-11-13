// The Worker entry `loadDefinitionInWorker` starts. It loads one Definition, posts what it read,
// and ends.
import { registerHooks } from "node:module";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { declaredRenames, definitionCatalog, definitionSchemas } from "../catalog/index.ts";
import type { LoadedDefinition } from "./definition-loader.ts";
import { definitionOf, importDefault } from "./definition-file.ts";

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
    const definition = definitionOf(file, await importNamingModule(file, files));
    return {
      catalog: definitionCatalog(definition),
      schemas: definitionSchemas(definition),
      renames: declaredRenames(definition),
      files: [...files],
    };
  } catch (error) {
    // Watch keeps watching a new import that broke, so a fix to it starts the next run.
    throw error instanceof Error ? Object.assign(error, { files: [...files] }) : error;
  }
}

async function importNamingModule(file: string, graph: ReadonlySet<string>): Promise<unknown> {
  try {
    return await importDefault(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failing = failingModule(error, graph) ?? file;
    throw new Error(`${relative(process.cwd(), failing)}: ${message}`, { cause: error });
  }
}

/**
 * The module of the graph that `error`'s stack names first: a throw's top frame, as a file URL, or
 * a syntax error's first line, as a path.
 */
function failingModule(error: unknown, graph: ReadonlySet<string>): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const named = [...graph]
    .map((file) => ({ file, at: firstMention(stack, file) }))
    .filter(({ at }) => at !== -1)
    .toSorted((a, b) => a.at - b.at);
  return named[0]?.file;
}

/** Where `stack` first names `file`, as a URL or a path followed by its line, or -1. */
function firstMention(stack: string, file: string): number {
  const found = [`${pathToFileURL(file).href}:`, `${file}:`]
    .map((needle) => stack.indexOf(needle))
    .filter((at) => at !== -1);
  return found.length === 0 ? -1 : Math.min(...found);
}
