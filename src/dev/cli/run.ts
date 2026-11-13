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
import { commit, generate, reset, type CommitOptions } from "../generate/index.ts";
import { generateDocument, type SuccessDocument } from "../output/index.ts";
import type { Project } from "./project.ts";
import { onProcessInterrupt } from "./signals.ts";

export type Driver = ReturnType<typeof postgresJsDriver>;

/** A command that runs against the Dev database and returns the document it prints. */
export type DatabaseCommand = { readonly config: string } & (
  | { readonly name: "generate"; readonly watch: false }
  | { readonly name: "migrate" }
  | { readonly name: "commit"; readonly slug: string; readonly accept: CommitOptions["accept"] }
  | { readonly name: "reset"; readonly erase: boolean }
);

export function run(command: DatabaseCommand, project: Project): Promise<SuccessDocument> {
  return withDriver(project, (driver) => runOn(driver, command, project));
}

export async function withDriver<T>(
  project: Project,
  use: (driver: Driver) => Promise<T>,
): Promise<T> {
  const sql = postgres(project.url, {
    onnotice: ignoreNotice,
    types: postgresJsTypes,
    connection: postgresJsConnection,
  });
  try {
    return await use(postgresJsDriver(sql));
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

function contextOf(driver: Driver, project: Project): Context {
  const { migrationsFolder: migrations, trackingSchema } = project;
  return { driver, project, migrations, tracking: { trackingSchema } };
}

function runOn(
  driver: Driver,
  command: DatabaseCommand,
  project: Project,
): Promise<SuccessDocument> {
  const context = contextOf(driver, project);
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

async function runGenerate({
  driver,
  project,
  migrations,
  tracking,
}: Context): Promise<SuccessDocument> {
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
  });
  return generateDocument(result, relative(process.cwd(), result.path));
}

async function runCommit(
  { driver, migrations, tracking }: Context,
  slug: string,
  accept: CommitOptions["accept"],
): Promise<SuccessDocument> {
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
): Promise<SuccessDocument> {
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

async function runMigrate({ driver, migrations, tracking }: Context): Promise<SuccessDocument> {
  const source = nodeMigrationSource(migrations);
  const { applied } = await migrate({ driver, source, ...tracking });
  return { command: "migrate", ok: true, applied };
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function logToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function ignoreNotice(): void {}
