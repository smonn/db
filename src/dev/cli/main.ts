import { parseArgs } from "node:util";
import { nodeFileSystem, nodeMigrationSource } from "../../adapters/node/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import { HAZARD_KINDS, type HazardKind } from "../diff/index.ts";
import { rebase } from "../generate/index.ts";
import { failureDocument, UsageError, type CommandName } from "../output/index.ts";
import { defaultBaseRef, gitMigrationSource, unheldPaths } from "./git.ts";
import { loadMigrationsFolder, loadProject } from "./project.ts";
import { documentLines, type Outcome } from "./report.ts";
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
                  to the remote's default branch

--json prints one JSON document on stdout instead of text. generate doesn't take it yet.`;

const DEFAULT_CONFIG = "smonndb.config.ts";

type OfflineCommand = { readonly config: string } & (
  | { readonly name: "verify" }
  | { readonly name: "rebase"; readonly onto: string | undefined }
);

type Command = DatabaseCommand | OfflineCommand;

/**
 * Runs one `smonndb` command and resolves to its exit code: 0, 1 on failure, 2 on misuse. With
 * `--json` it prints one document on stdout, success or failure, and nothing else on stderr but
 * progress.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.slice(0, endOfFlags(argv)).includes("--json");
  let name: CommandName | null = null;
  try {
    const command = parseCommand(argv);
    name = command.name;
    if (json && command.name === "generate") {
      throw new UsageError("generate doesn't take --json yet");
    }
    emit(await execute(command), json);
    return 0;
  } catch (error) {
    return reportFailure(error, { command: name ?? commandNameIn(argv), json });
  }
}

function endOfFlags(argv: readonly string[]): number {
  const end = argv.indexOf("--");
  return end === -1 ? argv.length : end;
}

async function execute(command: Command): Promise<Outcome> {
  if (command.name === "verify" || command.name === "rebase") return runOffline(command);
  return run(command, await loadProject(command.config));
}

function emit(outcome: Outcome, json: boolean): void {
  if (outcome === undefined) return;
  if (json) {
    print(JSON.stringify(outcome));
    return;
  }
  for (const line of documentLines(outcome)) print(line);
}

function reportFailure(
  error: unknown,
  { command, json }: { readonly command: CommandName | null; readonly json: boolean },
): number {
  const usage = error instanceof UsageError;
  if (json) {
    print(JSON.stringify(failureDocument(command, error)));
  } else if (usage) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  return usage ? 2 : 1;
}

/** Runs a command that reads the migrations folder and no database. */
async function runOffline(command: OfflineCommand): Promise<Outcome> {
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

const COMMAND_NAMES: readonly CommandName[] = [
  "generate",
  "commit",
  "reset",
  "migrate",
  "verify",
  "rebase",
];

/** The command the arguments name, read without validating anything else, or null. */
function commandNameIn(argv: readonly string[]): CommandName | null {
  const {
    positionals: [name],
  } = parseArgs({ args: [...argv], allowPositionals: true, strict: false, options: OPTIONS });
  return COMMAND_NAMES.find((known) => known === name) ?? null;
}

/** Each flag that only one command takes, and that command. */
const FLAG_COMMANDS = { accept: "commit", erase: "reset", onto: "rebase" } as const;

function checkNoArguments(name: string, args: readonly string[]): void {
  if (args.length > 0) throw new UsageError(`${name} takes no arguments: ${args.join(" ")}`);
}

const OPTIONS = {
  accept: { type: "string" },
  config: { type: "string" },
  erase: { type: "boolean" },
  json: { type: "boolean" },
  onto: { type: "string" },
} as const;

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
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

type CommandFlags = { readonly erase?: boolean; readonly onto?: string };

/** The commands that take no arguments, each building itself from the flag it alone accepts. */
const ARGUMENTLESS = {
  reset: (config: string, { erase }: CommandFlags): Command => ({
    name: "reset",
    erase: erase === true,
    config,
  }),
  rebase: (config: string, { onto }: CommandFlags): Command => ({ name: "rebase", config, onto }),
  generate: (config: string): Command => ({ name: "generate", config }),
  migrate: (config: string): Command => ({ name: "migrate", config }),
  verify: (config: string): Command => ({ name: "verify", config }),
};

function isArgumentless(name: string): name is keyof typeof ARGUMENTLESS {
  return Object.hasOwn(ARGUMENTLESS, name);
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
  return ARGUMENTLESS[name](config, values);
}
