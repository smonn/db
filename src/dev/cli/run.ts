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
import { commit, generate, reset, type CommitOptions } from "../generate/index.ts";
import type { Project } from "./project.ts";
import { generateReport, resetReport } from "./report.ts";
import { onProcessInterrupt } from "./signals.ts";

/** A command that runs against the Dev database. */
export type DatabaseCommand = { readonly config: string } & (
  | { readonly name: "generate" | "migrate" }
  | { readonly name: "commit"; readonly slug: string; readonly accept: CommitOptions["accept"] }
  | { readonly name: "reset"; readonly erase: boolean }
);

export async function run(command: DatabaseCommand, project: Project): Promise<void> {
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

type Context = {
  readonly driver: Driver;
  readonly project: Project;
  readonly migrations: string;
  readonly tracking: { readonly trackingSchema?: string };
};

function runOn(driver: Driver, command: DatabaseCommand, project: Project): Promise<void> {
  const { migrationsFolder: migrations, trackingSchema } = project;
  // Stryker disable next-line ConditionalExpression: every consumer defaults an undefined trackingSchema, and exactOptionalPropertyTypes only forbids writing the key as undefined.
  const tracking = trackingSchema === undefined ? {} : { trackingSchema };
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
    // Stryker disable next-line ConditionalExpression: unreachable, since the type forbids any other command name.
    default:
      return command satisfies never;
  }
}

async function runGenerate({ driver, project, migrations, tracking }: Context): Promise<void> {
  const result = await generate({
    driver,
    connect: postgresJsConnect(project.url, { onnotice: ignoreNotice }),
    fileSystem: nodeFileSystem(),
    definition: await project.loadDefinition(),
    migrations,
    ...tracking,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    onInterrupt: onProcessInterrupt(),
  });
  for (const line of generateReport(result, relative(process.cwd(), result.path))) print(line);
}

async function runCommit(
  { driver, migrations, tracking }: Context,
  slug: string,
  accept: CommitOptions["accept"],
): Promise<void> {
  const fileSystem = nodeFileSystem();
  const result = await commit({ driver, fileSystem, migrations, slug, accept, ...tracking });
  print(`wrote ${relative(process.cwd(), result.path)}`);
}

async function runReset({ driver, migrations, tracking }: Context, erase: boolean): Promise<void> {
  const fileSystem = nodeFileSystem();
  print(resetReport(await reset({ driver, fileSystem, migrations, erase, ...tracking })));
}

async function runMigrate({ driver, migrations, tracking }: Context): Promise<void> {
  const source = nodeMigrationSource(migrations);
  const { applied } = await migrate({ driver, source, ...tracking });
  print(applied.length === 0 ? "nothing to apply" : applied.map((f) => `applied ${f}`).join("\n"));
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ignoreNotice(): void {}
