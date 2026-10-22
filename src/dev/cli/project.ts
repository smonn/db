import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DefinitionTables } from "../catalog/index.ts";
import { parseConfig, type LoadedConfig } from "../config/index.ts";

export type Project = LoadedConfig & {
  /** `migrations`, resolved against the config file's folder. */
  readonly migrationsFolder: string;
  /** Imports the Definition file, resolved against the config file's folder. */
  loadDefinition(): Promise<DefinitionTables>;
};

/** Imports the config file at `config`, resolved against the working directory. */
export async function loadProject(config: string): Promise<Project> {
  const file = resolve(config);
  const loaded = parseConfig(await importDefault(file), relative(process.cwd(), file));
  return {
    ...loaded,
    migrationsFolder: resolve(dirname(file), loaded.migrations),
    loadDefinition: () => loadDefinition(resolve(dirname(file), loaded.definition)),
  };
}

async function loadDefinition(file: string): Promise<DefinitionTables> {
  const definition = await importDefault(file);
  if (!isDefinition(definition)) {
    throw new Error(
      `${relative(process.cwd(), file)} must export defineDatabase({ ... }) as its default export`,
    );
  }
  return definition;
}

function isDefinition(value: unknown): value is DefinitionTables {
  return typeof value === "object" && value !== null;
}

async function importDefault(file: string): Promise<unknown> {
  const module: unknown = await import(pathToFileURL(file).href);
  return typeof module === "object" && module !== null && "default" in module
    ? module.default
    : undefined;
}
