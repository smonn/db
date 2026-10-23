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
import { commit, generate, reset } from "../generate/index.ts";
import type { Project } from "./project.ts";
import { generateReport, resetReport } from "./report.ts";
import { onProcessInterrupt } from "./signals.ts";

/** A command that runs against the Dev database. */
export type DatabaseCommand = { readonly config: string } & (
  | { readonly name: "generate" | "migrate" }
  | { readonly name: "commit"; readonly slug: string }
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
        log: (line) => {
          process.stderr.write(`${line}\n`);
        },
        onInterrupt: onProcessInterrupt(),
      });
      for (const line of generateReport(result, relative(process.cwd(), result.path))) print(line);
      return;
    }
    case "commit": {
      const { slug } = command;
      const result = await commit({ driver, fileSystem, migrations, slug, ...tracking });
      print(`wrote ${relative(process.cwd(), result.path)}`);
      return;
    }
    case "reset": {
      const result = await reset({
        driver,
        fileSystem,
        migrations,
        erase: command.erase,
        ...tracking,
      });
      print(resetReport(result));
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

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ignoreNotice(): void {}
