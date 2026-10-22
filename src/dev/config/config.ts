/** One Database, as `smonndb.config.ts` describes it (ADR-0014). */
export type Config = {
  /** The Definition file, whose default export is `defineDatabase(...)`, relative to the config file. */
  readonly definition: string;
  /** The folder holding the Committed migrations and `current.sql`, relative to the config file. */
  readonly migrations: string;
  /** Read from the environment, such as `process.env.DATABASE_URL`. The CLI refuses `undefined`. */
  readonly url: string | undefined;
  /** The schema `migrate` tracks into. Defaults to `smonn_db`. */
  readonly trackingSchema?: string;
};

export type LoadedConfig = Config & { readonly url: string };

/** Types the config file's default export. */
export function defineConfig(config: Config): Config {
  return config;
}

const KEYS = new Set(["definition", "migrations", "url", "trackingSchema"]);

/** Checks a config file's default export, naming the file and what is wrong with it. */
export function parseConfig(value: unknown, file: string): LoadedConfig {
  const { url, ...rest } = readFields(value, file);
  if (url === undefined || url === "") {
    throw new Error(
      `${file}: url is ${url === "" ? "empty" : "undefined"}; set the environment variable it reads, such as DATABASE_URL`,
    );
  }
  if (typeof url !== "string") throw new Error(`${file}: url must be a string`);
  return { ...rest, url };
}

/** Like `parseConfig`, but ignores `url`, for commands that never connect. */
export function parseOfflineConfig(value: unknown, file: string): Omit<Config, "url"> {
  const { url: _url, ...rest } = readFields(value, file);
  return rest;
}

function readFields(value: unknown, file: string): Omit<Config, "url"> & { readonly url: unknown } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${file} must export defineConfig({ ... }) as its default export`);
  }
  const unknown = Object.keys(value).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${file}: unknown config key ${unknown.join(", ")}`);
  const fields: Record<string, unknown> = { ...value };
  const definition = requiredString(file, fields, "definition");
  const migrations = requiredString(file, fields, "migrations");
  const { url, trackingSchema } = fields;
  if (trackingSchema === undefined) return { definition, migrations, url };
  if (typeof trackingSchema !== "string")
    throw new Error(`${file}: trackingSchema must be a string`);
  return { definition, migrations, url, trackingSchema };
}

function requiredString(file: string, fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${file}: ${key} must be a non-empty path`);
  }
  return value;
}
