import { parseArgs } from "node:util";
import { nodeMigrationSource } from "../../adapters/node/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import { HAZARD_KINDS, type HazardKind } from "../diff/index.ts";
import { loadMigrationsFolder, loadProject } from "./project.ts";
import { print, run, type DatabaseCommand } from "./run.ts";

const USAGE = `usage: smonndb <command> [--config <path>]

commands:
  generate        write current.sql and replay it into the Dev database
  commit <slug> [--accept <kind,...>]
                  freeze current.sql into the next Committed migration; --accept names
                  the Hazard kinds to allow (data_loss, rewrite, access_exclusive_lock)
  reset [--erase] rebuild the Dev database from the migration files
  migrate         apply the pending Committed migrations
  verify          check the Committed migrations' hash chain, with no database`;

const DEFAULT_CONFIG = "smonndb.config.ts";

class UsageError extends Error {}

type Command = DatabaseCommand | { readonly config: string; readonly name: "verify" };

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

function parseCommand(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        accept: { type: "string" },
        config: { type: "string" },
        erase: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const [name, ...args] = parsed.positionals;
  const config = parsed.values.config ?? DEFAULT_CONFIG;
  const erase = parsed.values.erase === true;
  if (erase && name !== "reset") throw new UsageError("--erase applies only to reset");
  if (parsed.values.accept !== undefined && name !== "commit") {
    throw new UsageError("--accept applies only to commit");
  }
  switch (name) {
    case "reset":
      if (args.length > 0) throw new UsageError(`reset takes no arguments: ${args.join(" ")}`);
      return { name, erase, config };
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
      return { name, slug, config, accept: parseAccept(parsed.values.accept) };
    }
    case undefined:
      throw new UsageError("name a command");
    default:
      throw new UsageError(`unknown command ${name}`);
  }
}
