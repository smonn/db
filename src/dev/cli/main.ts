import { relative } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { nodeFileSystem, nodeMigrationSource } from "../../adapters/node/index.ts";
import {
  postgresJsConnect,
  postgresJsConnection,
  postgresJsDriver,
  postgresJsTypes,
} from "../../adapters/postgres-js/index.ts";
import { migrate, verify } from "../../runtime/migrator/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { commit, generate } from "../generate/index.ts";
import { loadMigrationsFolder, loadProject, type Project } from "./project.ts";

const USAGE = `usage: smonndb <command> [--config <path>]

commands:
  generate        write current.sql and replay it into the Dev database
  commit <slug>   freeze current.sql into the next Committed migration
  migrate         apply the pending Committed migrations
  verify          check the Committed migrations' hash chain, with no database`;

const DEFAULT_CONFIG = "smonndb.config.ts";

class UsageError extends Error {}

type Command = { readonly config: string } & (
  | { readonly name: "generate" | "migrate" }
  | { readonly name: "verify" }
  | { readonly name: "commit"; readonly slug: string }
);

type DatabaseCommand = Exclude<Command, { readonly name: "verify" }>;

/** Runs one `smonndb` command and resolves to its exit code: 0, 1 on failure, 2 on misuse. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const command = parseCommand(argv);
    if (command.name === "verify") {
      const { verified } = await verify(
        nodeMigrationSource(await loadMigrationsFolder(command.config)),
      );
      print(`verified ${verified.length} ${verified.length === 1 ? "migration" : "migrations"}`);
      return 0;
    }
    const project = await loadProject(command.config);
    await run(command, project);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseCommand(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { config: { type: "string" } },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const [name, ...args] = parsed.positionals;
  const config = parsed.values.config ?? DEFAULT_CONFIG;
  switch (name) {
    case "generate":
    case "migrate":
    case "verify":
      if (args.length > 0) throw new UsageError(`${name} takes no arguments: ${args.join(" ")}`);
      return { name, config };
    case "commit": {
      const [slug] = args;
      if (slug === undefined || args.length > 1) {
        throw new UsageError("commit takes one argument, the slug");
      }
      return { name, slug, config };
    }
    case undefined:
      throw new UsageError("name a command");
    default:
      throw new UsageError(`unknown command ${name}`);
  }
}

async function run(command: DatabaseCommand, project: Project): Promise<void> {
  const sql = postgres(project.url, {
    onnotice: ignoreNotice,
    types: postgresJsTypes,
    connection: postgresJsConnection,
  });
  try {
    await runOn(postgresJsDriver(sql), command, project);
  } finally {
    // Every statement has settled, and a graceful end() never settles once a backend ended
    // mid-statement (porsager/postgres#1226), which would swallow the error.
    await sql.end({ timeout: 0 });
  }
}

async function runOn(driver: Driver, command: DatabaseCommand, project: Project): Promise<void> {
  const { migrationsFolder: migrations, trackingSchema } = project;
  const tracking = trackingSchema === undefined ? {} : { trackingSchema };
  const fileSystem = nodeFileSystem();
  switch (command.name) {
    case "generate": {
      const result = await generate({
        driver,
        connect: postgresJsConnect(project.url, { onnotice: ignoreNotice }),
        fileSystem,
        definition: await project.loadDefinition(),
        migrations,
        ...tracking,
      });
      const path = relative(process.cwd(), result.path);
      if (result.diff !== undefined) {
        const differs = result.diff === "" ? "matches what generate would write" : result.diff;
        print(`kept hand-edited ${path}, replayed as written; diff to what generate would write:`);
        print(differs.trimEnd());
        return;
      }
      print(result.sql === undefined ? `no diff, removed ${path}` : `wrote ${path}`);
      return;
    }
    case "commit": {
      const { slug } = command;
      const result = await commit({ driver, fileSystem, migrations, slug, ...tracking });
      print(`wrote ${relative(process.cwd(), result.path)}`);
      return;
    }
    case "migrate": {
      const source = nodeMigrationSource(migrations);
      const { applied } = await migrate({ driver, source, ...tracking });
      print(
        applied.length === 0 ? "nothing to apply" : applied.map((f) => `applied ${f}`).join("\n"),
      );
    }
  }
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ignoreNotice(): void {}
