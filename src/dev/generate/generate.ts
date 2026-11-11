import {
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  quoteIdentifier,
  readCommitted,
  trackingSchema,
  writeCurrent,
} from "../../runtime/internal/index.ts";
import type { Connect, Driver, FileSystem, MigrationSource } from "../../runtime/ports/index.ts";
import { declaredRenames, definitionSchemas, type DefinitionTables } from "../catalog/index.ts";
import type { Hazard } from "../diff/index.ts";
import { skippedSchemaReason } from "../introspect/index.ts";
import type { ShadowOptions } from "../shadow/index.ts";
import {
  catchUp,
  lockDevDatabase,
  type CatchUpTarget,
  type DevDatabaseOutcome,
} from "./catch-up.ts";
import { lockWaitNotice, withDevLock } from "./dev-lock.ts";
import { lineDiff } from "./line-diff.ts";
import { diffInShadow, type ShadowDiff } from "./shadow-diff.ts";

export type GenerateOptions = ShadowOptions & {
  /** The Dev database, which also creates and drops the Shadow and Definition databases. */
  readonly driver: Driver;
  readonly connect: Connect;
  readonly fileSystem: FileSystem;
  readonly definition: DefinitionTables;
  /** The directory holding the Committed migrations and `current.sql`. */
  readonly migrations: string;
  /** The schema `migrate` tracks into. Defaults to `smonn_db`. */
  readonly trackingSchema?: string;
  /** Stops the wait for the migrator's lock; the wait then rejects (see `acquireMigrationLock`). */
  readonly signal?: AbortSignal;
  /**
   * Set to refuse a hand edit that leaves a difference from the Definition, before the Dev database
   * changes (ADR-0031). `config` names the config file in the refusal.
   */
  readonly strict?: { readonly config: string };
};

export type GenerateResult = {
  readonly path: string;
  /** The Current migration's body, or `undefined` when there was no diff and the file was deleted. */
  readonly sql: string | undefined;
  /**
   * What generate did to `current.sql`: `kept` when the file already held what generate would
   * write, or was hand-edited, so a run that changes nothing stays silent (ADR-0032).
   */
  readonly file: "written" | "removed" | "kept";
  /**
   * Set when `current.sql` was hand-edited, so generate kept and replayed it as written (ADR-0003):
   * the lines that differ from what generate would have written, `-` for the file and `+` for the
   * generation. Empty when they match. `sql` is then the replayed body.
   */
  readonly diff?: string;
  /**
   * Set beside `diff` when the hand edit, run in the Shadow, leaves the Shadow unlike the
   * Definition (ADR-0013). A warning, not a failure: the edit is the user's to finish.
   */
  readonly leftover?: string;
  /** What generate did to the Dev database, which it changes only when the files left it behind. */
  readonly devDatabase: DevDatabaseOutcome;
  /**
   * Every Hazard in the diff generate computed, for the CLI to print and gate (ADR-0015). Empty when
   * there was no diff. Beside a hand-edited `sql` (`diff` set) these are the generation's, not the
   * edit's: the edit keeps its own `-- hazard:` comments.
   */
  readonly hazards: readonly Hazard[];
  /**
   * Renames the Definition could declare, one line each, for a drop and an add that look like one
   * (ADR-0024). Generate never writes a guessed rename into the SQL.
   */
  readonly hints: readonly string[];
};

/**
 * Diffs the Definition against the Committed migrations, verifies the result in the Shadow
 * database, writes it to `current.sql`, then catches the Dev database up when it has fallen behind
 * the files, replaying only the new ones where it can and diffing it against the Shadow otherwise,
 * so it keeps its data. A hand-edited
 * `current.sql` is verified in the Shadow instead (a leftover difference is a warning, or a refusal
 * in strict mode), replayed as written and left alone. Holds the Dev lock, so a second run fails at once, and the migrator's lock
 * from the Dev database check on, so a runtime `migrate` waits instead of changing the Database
 * under it.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const tracking = trackingSchema(options.trackingSchema ?? DEFAULT_TRACKING_SCHEMA);
  requireModeledSchemas(options.definition, tracking.name);
  const result = await withDevLock(options.driver, "generate", (driver) =>
    generateLocked({ ...options, driver }),
  );
  return result;
}

async function generateLocked(options: GenerateOptions): Promise<GenerateResult> {
  const {
    driver,
    connect,
    fileSystem,
    definition,
    migrations,
    trackingSchema: trackingName = DEFAULT_TRACKING_SCHEMA,
    signal,
    strict,
    ...shadowOptions
  } = options;
  const { log } = shadowOptions;
  const tracking = trackingSchema(trackingName);
  await lockDevDatabase(driver, tracking, { signal, onWait: lockWaitNotice(log) });
  const path = `${migrations}/${CURRENT_FILENAME}`;
  const existing = await fileSystem.readFile(path);
  const edited = await handEditedBody(existing);
  await fileSystem.mkdir(migrations);
  const committed = await readCommitted(fileSystem, migrations);
  const source: MigrationSource = { list: () => Promise.resolve(committed) };

  const shadowDiff = await diffInShadow({
    driver,
    connect,
    source,
    definition,
    tracking,
    shadowOptions,
    edited,
  });

  if (strict !== undefined && shadowDiff.leftover !== undefined) {
    throw new Error(strictRefusal(shadowDiff.leftover, path, strict.config));
  }

  const declared = declaredRenames(definition);
  const kept = { driver, source, tracking, committed, path, shadow: shadowDiff.shadow, declared };
  if (edited !== undefined) return replayEdited(kept, edited, shadowDiff);
  return writeGenerated({ ...kept, fileSystem, existing }, shadowDiff);
}

/**
 * Writes the generation to `current.sql`, or deletes the file when there is no diff, and leaves a
 * file that already holds it alone.
 */
async function writeGenerated(
  {
    fileSystem,
    existing,
    ...kept
  }: KeptEdit & { readonly fileSystem: FileSystem; readonly existing: string | undefined },
  { sql, hazards, hints }: ShadowDiff,
): Promise<GenerateResult> {
  const { path } = kept;
  if (sql === "") {
    if (existing !== undefined) await fileSystem.remove(path);
    const devDatabase = await catchUp(kept);
    const file = existing === undefined ? "kept" : "removed";
    return { path, sql: undefined, file, devDatabase, hazards: [], hints };
  }
  const current = await writeCurrent(sql);
  const file = existing === current.content ? "kept" : "written";
  if (file === "written") await fileSystem.writeFile(path, current.content);
  const devDatabase = await catchUp(kept, current);
  return { path, sql: current.body, file, devDatabase, hazards, hints };
}

type KeptEdit = CatchUpTarget & { readonly path: string };

/** Replays a hand-edited `current.sql` as written and reports how it differs from the generation. */
async function replayEdited(
  kept: KeptEdit,
  edited: string,
  { sql, hazards, hints, leftover }: ShadowDiff,
): Promise<GenerateResult> {
  const devDatabase = await catchUp(kept, { body: edited, hash: await currentHash(edited) });
  const generated = await writeCurrent(sql);
  const diff = lineDiff(edited, generated.body);
  return {
    path: kept.path,
    sql: edited,
    file: "kept",
    diff,
    ...(leftover === undefined ? {} : { leftover }),
    devDatabase,
    hazards,
    hints,
  };
}

function strictRefusal(leftover: string, path: string, config: string): string {
  return [
    `error: current.sql leaves a difference from the Definition (strict mode, ${config}):`,
    leftover,
    `fix the hand edit in ${path}, or set strict: false in ${config}`,
  ].join("\n");
}

/** Refuses a schema `introspect` skips, whose tables would otherwise vanish from `current.sql`. */
function requireModeledSchemas(definition: DefinitionTables, trackingName: string): void {
  for (const schema of definitionSchemas(definition)) {
    const reason = skippedSchemaReason(schema, trackingName);
    if (reason !== undefined) {
      throw new Error(
        `the Definition names schema ${quoteIdentifier(schema)}, which generate skips as ${reason}`,
      );
    }
  }
}

/** The body of a `current.sql` whose body no longer matches its `--! Generated:` header (ADR-0003). */
async function handEditedBody(content: string | undefined): Promise<string | undefined> {
  if (content === undefined) return undefined;
  const parsed = await parseCurrent(content);
  return parsed.edited ? parsed.body : undefined;
}
