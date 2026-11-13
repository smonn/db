import { nodeFileSystem, nodeMigrationSource } from "../../adapters/node/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import { rebase } from "../generate/index.ts";
import { defaultBaseRef, gitMigrationSource, unheldPaths } from "./git.ts";
import { loadMigrationsFolder } from "./project.ts";
import type { Outcome } from "./report.ts";

export type OfflineCommand = { readonly config: string } & (
  | { readonly name: "verify" }
  | { readonly name: "rebase"; readonly onto: string | undefined }
);

/** Runs a command that reads the migrations folder and no database. */
export async function runOffline(command: OfflineCommand): Promise<Outcome> {
  const migrations = await loadMigrationsFolder(command.config);
  if (command.name === "verify") {
    const { verified } = await verify(nodeMigrationSource(migrations));
    return { command: "verify", ok: true, verified };
  }
  const fileSystem = nodeFileSystem();
  // Git can't run in a missing folder; listing it first fails the way verify does.
  await fileSystem.list(migrations);
  const onto = command.onto ?? (await defaultBaseRef(migrations));
  const unheld = await unheldPaths(migrations);
  const base = gitMigrationSource(migrations, onto);
  const { moved } = await rebase({ fileSystem, migrations, base, onto, unheld });
  return { command: "rebase", ok: true, onto, moved };
}
