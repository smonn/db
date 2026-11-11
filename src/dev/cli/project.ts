import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_TRACKING_SCHEMA } from "../../runtime/internal/index.ts";
import type { DefinitionTables } from "../catalog/index.ts";
import { parseConfig, parseOfflineConfig, type LoadedConfig } from "../config/index.ts";

export type Project = LoadedConfig & {
  /** The config's `trackingSchema`, or the default one. */
  readonly trackingSchema: string;
  /** The config file, relative to the working directory, as errors name it. */
  readonly configPath: string;
  /** `migrations`, resolved against the config file's folder. */
  readonly migrationsFolder: string;
  /** Imports the Definition file, resolved against the config file's folder. */
  loadDefinition(): Promise<DefinitionTables>;
};

/** Imports the config file at `config`, resolved against the working directory. */
export async function loadProject(config: string): Promise<Project> {
  const file = resolve(config);
  const configPath = relative(process.cwd(), file);
  const loaded = parseConfig(await importDefault(file), configPath);
  return {
    ...loaded,
    configPath,
    trackingSchema: loaded.trackingSchema ?? DEFAULT_TRACKING_SCHEMA,
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
  return definitionOf(file, await importDefault(file));
}

/** Refuses `value`, the default export of the Definition file at `file`, unless it's a Definition. */
export function definitionOf(file: string, value: unknown): DefinitionTables {
  if (!isDefinition(value)) {
    throw new Error(
      `${relative(process.cwd(), file)} must export defineDatabase({ ... }) as its default export`,
    );
  }
  return value;
}

function isDefinition(value: unknown): value is DefinitionTables {
  return typeof value === "object" && value !== null;
}

export function importDefault(file: string): Promise<unknown> {
  return import(pathToFileURL(file).href).then(
    (module: { readonly default?: unknown }) => module.default,
  );
}
