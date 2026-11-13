import { relative } from "node:path";
import postgres from "postgres";
import { nodeFileSystem, nodeMigrationSource } from "../../adapters/node/index.ts";
import {
  postgresJsConnect,
  postgresJsConnection,
  postgresJsDriver,
  postgresJsTypes,
} from "../../adapters/postgres-js/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import {
  CatchUpFailedError,
  commit,
  generate,
  reset,
  type CommitOptions,
} from "../generate/index.ts";
import type { Project } from "./project.ts";
import { generatedLines, generateReport, type Outcome } from "./report.ts";
import { onProcessInterrupt } from "./signals.ts";

/** A command that runs against the Dev database. */
export type DatabaseCommand = { readonly config: string } & (
  | { readonly name: "generate" | "migrate" }
  | { readonly name: "commit"; readonly slug: string; readonly accept: CommitOptions["accept"] }
  | { readonly name: "reset"; readonly erase: boolean }
);

export async function run(command: DatabaseCommand, project: Project): Promise<Outcome> {
  const sql = postgres(project.url, {
    onnotice: ignoreNotice,
    types: postgresJsTypes,
    connection: postgresJsConnection,
  });
  try {
    return await runOn(postgresJsDriver(sql), command, project);
  } finally {
    // Every statement has settled, and a graceful end() never settles once a backend ended
    // mid-statement (porsager/postgres#1226), which would swallow the error.
    await sql.end({ timeout: 0 });
  }
}

type Context = {
  readonly driver: Driver;
  readonly project: Project;
  readonly migrations: string;
  readonly tracking: { readonly trackingSchema: string };
};

function runOn(driver: Driver, command: DatabaseCommand, project: Project): Promise<Outcome> {
  const { migrationsFolder: migrations, trackingSchema } = project;
  const tracking = { trackingSchema };
  const context = { driver, project, migrations, tracking };
  switch (command.name) {
    case "generate":
      return runGenerate(context);
    case "migrate":
      return runMigrate(context);
    case "commit":
      return runCommit(context, command.slug, command.accept);
    case "reset":
      return runReset(context, command.erase);
    // Stryker disable next-line ConditionalExpression: 1 survivor: unreachable, since the type forbids any other command name.
    default:
      return command satisfies never;
  }
}

async function runGenerate({ driver, project, migrations, tracking }: Context): Promise<undefined> {
  const result = await generate({
    driver,
    connect: postgresJsConnect(project.url, { onnotice: ignoreNotice }),
    fileSystem: nodeFileSystem(),
    definition: await project.loadDefinition(),
    migrations,
    ...tracking,
    ...(project.strict === true ? { strict: { config: project.configPath } } : {}),
    log: logToStderr,
    onInterrupt: onProcessInterrupt(),
  }).catch((error: unknown) => {
    // The file is settled and the next run keeps it, so this run is the only one to print its Hazards.
    if (error instanceof CatchUpFailedError) {
      printLines(generatedLines(error.generated, relativePath(error.generated.path)));
    }
    throw error;
  });
  printLines(generateReport(result, relativePath(result.path)));
  return undefined;
}

function relativePath(path: string): string {
  return relative(process.cwd(), path);
}

function printLines(lines: readonly string[]): void {
  for (const line of lines) print(line);
}

async function runCommit(
  { driver, migrations, tracking }: Context,
  slug: string,
  accept: CommitOptions["accept"],
): Promise<Outcome> {
  const fileSystem = nodeFileSystem();
  const result = await commit({
    driver,
    fileSystem,
    migrations,
    slug,
    accept,
    log: logToStderr,
    ...tracking,
  });
  return { command: "commit", ok: true, file: { path: relative(process.cwd(), result.path) } };
}

async function runReset(
  { driver, migrations, tracking }: Context,
  erase: boolean,
): Promise<Outcome> {
  const fileSystem = nodeFileSystem();
  const { committed, current } = await reset({
    driver,
    fileSystem,
    migrations,
    erase,
    log: logToStderr,
    ...tracking,
  });
  return { command: "reset", ok: true, committed, current };
}

async function runMigrate({ driver, migrations, tracking }: Context): Promise<Outcome> {
  const source = nodeMigrationSource(migrations);
  const { applied } = await migrate({ driver, source, ...tracking });
  return { command: "migrate", ok: true, applied };
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function logToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function ignoreNotice(): void {}
