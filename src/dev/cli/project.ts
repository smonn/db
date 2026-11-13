import { dirname, relative, resolve } from "node:path";
import { DEFAULT_TRACKING_SCHEMA } from "../../runtime/internal/index.ts";
import type { DefinitionTables } from "../catalog/index.ts";
import { parseConfig, parseOfflineConfig, type LoadedConfig } from "../config/index.ts";
import { definitionOf, importDefault } from "./definition-file.ts";

export type Project = LoadedConfig & {
  /** The config's `trackingSchema`, or the default one. */
  readonly trackingSchema: string;
  /** The config file, relative to the working directory, as errors name it. */
  readonly configPath: string;
  /** `migrations`, resolved against the config file's folder. */
  readonly migrationsFolder: string;
  /** The Definition file, resolved against the config file's folder. */
  readonly definitionFile: string;
  /** Imports the Definition file. */
  loadDefinition(): Promise<DefinitionTables>;
};

/** Imports the config file at `config`, resolved against the working directory. */
export async function loadProject(config: string): Promise<Project> {
  const file = resolve(config);
  const configPath = relative(process.cwd(), file);
  const loaded = parseConfig(await importDefault(file), configPath);
  const definitionFile = resolve(dirname(file), loaded.definition);
  return {
    ...loaded,
    configPath,
    trackingSchema: loaded.trackingSchema ?? DEFAULT_TRACKING_SCHEMA,
    migrationsFolder: resolve(dirname(file), loaded.migrations),
    definitionFile,
    loadDefinition: () => loadDefinition(definitionFile),
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
