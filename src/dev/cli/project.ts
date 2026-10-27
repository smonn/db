import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DefinitionTables } from "../catalog/index.ts";
import { parseConfig, parseOfflineConfig, type LoadedConfig } from "../config/index.ts";

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

/** Resolves the migrations folder of the config file at `config`, which needs no `url`. */
export async function loadMigrationsFolder(config: string): Promise<string> {
  const file = resolve(config);
  const loaded = parseOfflineConfig(await importDefault(file), relative(process.cwd(), file));
  return resolve(dirname(file), loaded.migrations);
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

function importDefault(file: string): Promise<unknown> {
  return import(pathToFileURL(file).href).then(
    (module: { readonly default?: unknown }) => module.default,
  );
}
