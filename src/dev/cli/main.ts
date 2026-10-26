import { parseArgs } from "node:util";
import { nodeFileSystem, nodeMigrationSource } from "../../adapters/node/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import { HAZARD_KINDS, type HazardKind } from "../diff/index.ts";
import { rebase } from "../generate/index.ts";
import { defaultBaseRef, gitMigrationSource, unheldPaths } from "./git.ts";
import { loadMigrationsFolder, loadProject } from "./project.ts";
import { rebaseReport } from "./report.ts";
import { print, run, type DatabaseCommand } from "./run.ts";

const USAGE = `usage: smonndb <command> [--config <path>]

commands:
  generate        write current.sql and replay it into the Dev database
  commit <slug> [--accept <kind,...>]
                  freeze current.sql into the next Committed migration; --accept names
                  the Hazard kinds to allow (data_loss, rewrite, access_exclusive_lock,
                  share_lock, share_row_exclusive_lock, rename)
  reset [--erase] rebuild the Dev database from the migration files
  migrate         apply the pending Committed migrations
  verify          check the Committed migrations' hash chain, with no database
  rebase [--onto <ref>]
                  move the Committed migrations <ref> lacks onto its tip; <ref> defaults
                  to the remote's default branch`;

const DEFAULT_CONFIG = "smonndb.config.ts";

class UsageError extends Error {}

type OfflineCommand = { readonly config: string } & (
  | { readonly name: "verify" }
  | { readonly name: "rebase"; readonly onto: string | undefined }
);

type Command = DatabaseCommand | OfflineCommand;

/** Runs one `smonndb` command and resolves to its exit code: 0, 1 on failure, 2 on misuse. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    await execute(parseCommand(argv));
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
}

async function execute(command: Command): Promise<void> {
  if (command.name === "verify" || command.name === "rebase") {
    for (const line of await runOffline(command)) print(line);
    return;
  }
  await run(command, await loadProject(command.config));
}

function reportFailure(error: unknown): number {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

/** Runs a command that reads the migrations folder and no database, and returns its lines. */
async function runOffline(command: OfflineCommand): Promise<string[]> {
  const migrations = await loadMigrationsFolder(command.config);
  if (command.name === "verify") {
    const { verified } = await verify(nodeMigrationSource(migrations));
    return [`verified ${verified.length} ${verified.length === 1 ? "migration" : "migrations"}`];
  }
  const fileSystem = nodeFileSystem();
  // Git can't run in a missing folder; listing it first fails the way verify does.
  await fileSystem.list(migrations);
  const onto = command.onto ?? (await defaultBaseRef(migrations));
  const unheld = await unheldPaths(migrations);
  const base = gitMigrationSource(migrations, onto);
  return rebaseReport(await rebase({ fileSystem, migrations, base, onto, unheld }), onto);
}

function parseAccept(value: string | undefined): HazardKind[] {
  const accepted: HazardKind[] = [];
  for (const kind of value === undefined ? [] : value.split(",")) {
    const known = HAZARD_KINDS.find((candidate) => candidate === kind);
    if (known === undefined) {
      throw new UsageError(
        `unknown Hazard kind ${JSON.stringify(kind)}; the kinds are ${HAZARD_KINDS.join(", ")}`,
      );
    }
    accepted.push(known);
  }
  return accepted;
}

/** Each flag that only one command takes, and that command. */
const FLAG_COMMANDS = { accept: "commit", erase: "reset", onto: "rebase" } as const;

function checkNoArguments(name: string, args: readonly string[]): void {
  if (args.length > 0) throw new UsageError(`${name} takes no arguments: ${args.join(" ")}`);
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        accept: { type: "string" },
        config: { type: "string" },
        erase: { type: "boolean" },
        onto: { type: "string" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function checkFlagScope(values: object, name: string | undefined): void {
  for (const [flag, command] of Object.entries(FLAG_COMMANDS)) {
    if (Object.hasOwn(values, flag) && name !== command) {
      throw new UsageError(`--${flag} applies only to ${command}`);
    }
  }
}

function parseCommit(
  args: readonly string[],
  config: string,
  accept: string | undefined,
): DatabaseCommand {
  const [slug] = args;
  if (slug === undefined || args.length > 1) {
    throw new UsageError("commit takes one argument, the slug");
  }
  return { name: "commit", slug, config, accept: parseAccept(accept) };
}

function parseCommand(argv: readonly string[]): Command {
  const parsed = parseFlags(argv);
  const [name, ...args] = parsed.positionals;
  const config = parsed.values.config ?? DEFAULT_CONFIG;
  checkFlagScope(parsed.values, name);
  return commandNamed(name, args, config, parsed.values);
}

const ARGUMENTLESS = ["reset", "rebase", "generate", "migrate", "verify"] as const;

type ArgumentlessName = (typeof ARGUMENTLESS)[number];

function isArgumentless(name: string): name is ArgumentlessName {
  return ARGUMENTLESS.some((candidate) => candidate === name);
}

/** A command that takes no arguments, with the flag it alone accepts. */
function flagged(
  name: ArgumentlessName,
  config: string,
  values: { readonly erase?: boolean; readonly onto?: string },
): Command {
  if (name === "reset") return { name, erase: values.erase === true, config };
  if (name === "rebase") return { name, config, onto: values.onto };
  return { name, config };
}

function commandNamed(
  name: string | undefined,
  args: readonly string[],
  config: string,
  values: { readonly erase?: boolean; readonly onto?: string; readonly accept?: string },
): Command {
  if (name === undefined) throw new UsageError("name a command");
  if (name === "commit") return parseCommit(args, config, values.accept);
  if (!isArgumentless(name)) throw new UsageError(`unknown command ${name}`);
  checkNoArguments(name, args);
  return flagged(name, config, values);
}
