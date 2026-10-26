import {
  CURRENT_FILENAME,
  committedFilenames,
  migrationHash,
  parseMigration,
  readCommitted,
  writeMigration,
  type ParsedMigration,
} from "../../runtime/internal/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import type { FileSystem, MigrationFile, MigrationSource } from "../../runtime/ports/index.ts";

export type RebaseOptions = {
  readonly fileSystem: FileSystem;
  /** The directory holding the Committed migrations. */
  readonly migrations: string;
  /** The Committed migrations in the base ref, which never move. */
  readonly base: MigrationSource;
  /** The base ref's name, for messages, such as `origin/main`. */
  readonly onto: string;
  /** The paths under `migrations`, relative to it, that differ from the last commit, are untracked, or are gitignored. */
  readonly unheld: readonly string[];
};

export type RebaseResult = {
  /** Each Committed migration rewritten, by its old and new filename, in chain order. */
  readonly moved: readonly { readonly from: string; readonly to: string }[];
};

type Move = {
  readonly from: ParsedMigration;
  readonly to: MigrationFile & { readonly hash: string };
};

/**
 * Moves the Committed migrations the base ref lacks onto its tip, in chain order, rewriting each
 * file's sequence and headers (ADR-0008). Files the base ref holds stay byte for byte. Refuses,
 * writing nothing, unless the folder holds every base file, each moving file still matches its
 * Hash, and the moving files chain onto each other from a file the base ref holds. Refuses first
 * when git doesn't hold the folder as committed, so git can always restore what it overwrites.
 */
export async function rebase(options: RebaseOptions): Promise<RebaseResult> {
  const { fileSystem, migrations, onto } = options;
  checkHeld(options.unheld, migrations);
  const base = await verifiedBase(options.base, onto);
  const local = await readCommitted(fileSystem, migrations);
  const parsed = local
    .map((file) => parseMigration(file))
    .toSorted((a, b) => a.sequence - b.sequence || (a.filename < b.filename ? -1 : 1));
  checkHoldsBase(parsed, base, { migrations, onto });

  const baseHashes = new Set(base.map(({ hash }) => hash));
  const moving = parsed.filter(({ hash }) => !baseHashes.has(hash));
  await checkMovingChain(moving, baseHashes, onto);

  const moves = await rewrite(moving, base.at(-1)?.hash, base.length);
  const staying = local.filter((file) => !moving.some((m) => m.filename === file.filename));
  await verify({ list: () => Promise.resolve([...staying, ...moves.map(({ to }) => to)]) });

  const changed = moves.filter(
    ({ from, to }) => from.filename !== to.filename || from.hash !== to.hash,
  );
  if (changed.length === 0) return { moved: [] };

  await applyMoves(fileSystem, migrations, { changed, moves, moving });
  return { moved: moves.map(({ from, to }) => ({ from: from.filename, to: to.filename })) };
}

/** Writes the changed moves, then removes each old name no move reuses. */
async function applyMoves(
  fileSystem: FileSystem,
  migrations: string,
  {
    changed,
    moves,
    moving,
  }: {
    readonly changed: readonly Move[];
    readonly moves: readonly Move[];
    readonly moving: readonly ParsedMigration[];
  },
): Promise<void> {
  try {
    await writeMoves(fileSystem, migrations, changed);
    const newNames = new Set(moves.map(({ to }) => to.filename));
    for (const { filename } of moving) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, so a failure stops the rest.
      if (!newNames.has(filename)) await fileSystem.remove(`${migrations}/${filename}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${migrations} may be half-rewritten (${message}); rerun rebase to finish, or to list the files to set aside`,
      { cause: error },
    );
  }
}

/** Only the top-level files rebase reads or writes count: Committed migrations and leftover `.sql.tmp` files. */
function checkHeld(unheld: readonly string[], migrations: string): void {
  const topLevel = unheld.filter((path) => !path.includes("/"));
  const paths = [
    ...committedFilenames(topLevel),
    ...topLevel.filter((path) => path.endsWith(".sql.tmp")),
  ].toSorted();
  if (paths.length === 0) return;
  // Naming the files fails once one is deleted in the index: git stashes, then rejects the pathspec.
  // --all, since --include-untracked skips the gitignored files this guard also reports.
  throw new Error(
    `${migrations} has changes git doesn't hold: ${paths.join(", ")}; set them aside with git -C ${shellQuote(migrations)} stash push --all -- . ':(exclude)${CURRENT_FILENAME}', then rerun rebase`,
  );
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes each move to a temporary name, then renames it into place, so a failed write never
 * truncates a file. Before a move replaces another moving file's old name, that file is moved to
 * its own new name, so every body stays under a migration's name throughout.
 */
async function writeMoves(
  fileSystem: FileSystem,
  migrations: string,
  changed: readonly Move[],
): Promise<void> {
  const byOldName = new Map(changed.map((move) => [move.from.filename, move]));
  const written = new Set<Move>();
  const write = async (move: Move): Promise<void> => {
    if (written.has(move)) return;
    written.add(move);
    const occupant = byOldName.get(move.to.filename);
    if (occupant !== undefined) await write(occupant);
    const path = `${migrations}/${move.to.filename}`;
    await fileSystem.writeFile(`${path}.tmp`, move.to.content);
    await fileSystem.rename(`${path}.tmp`, path);
  };
  for (const move of changed) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, in a safe order.
    await write(move);
  }
}

async function verifiedBase(source: MigrationSource, onto: string): Promise<ParsedMigration[]> {
  const files = await source.list();
  try {
    await verify({ list: () => Promise.resolve(files) });
  } catch (error) {
    throw new Error(`${onto}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return files.map((file) => parseMigration(file)).toSorted((a, b) => a.sequence - b.sequence);
}

function checkHoldsBase(
  local: readonly ParsedMigration[],
  base: readonly ParsedMigration[],
  { migrations, onto }: { readonly migrations: string; readonly onto: string },
): void {
  const baseByName = new Map(base.map(({ filename, hash }) => [filename, hash]));
  for (const { filename, hash } of local) {
    const baseHash = baseByName.get(filename);
    if (baseHash !== undefined && baseHash !== hash) {
      throw new Error(`${filename}: differs from its copy in ${onto}`);
    }
  }
  const localHashes = new Set(local.map(({ hash }) => hash));
  for (const { filename, hash } of base) {
    if (!localHashes.has(hash)) {
      throw new Error(`${onto} has ${filename}, which ${migrations} lacks; merge ${onto} first`);
    }
  }
}

async function checkMovingChain(
  moving: readonly ParsedMigration[],
  baseHashes: ReadonlySet<string>,
  onto: string,
): Promise<void> {
  const [first] = moving;
  if (first?.previous !== undefined && !baseHashes.has(first.previous)) {
    throw new Error(`${first.filename}: follows ${first.previous}, which ${onto} lacks`);
  }
  const actualHashes = await Promise.all(
    moving.map((migration) => migrationHash(migration.previous, migration.body, migration)),
  );
  moving.forEach((migration, index) => {
    const previous = moving[index - 1];
    if (previous !== undefined && migration.previous !== previous.hash) {
      throw new Error(
        `${migration.filename}: --! Previous should be ${previous.hash}, not ${migration.previous ?? "-"}`,
      );
    }
    const actual = actualHashes[index];
    if (actual !== migration.hash) {
      throw new Error(
        `${migration.filename}: --! Hash says ${migration.hash} but the body hashes to ${actual}`,
      );
    }
  });
}

async function rewrite(
  moving: readonly ParsedMigration[],
  tip: string | undefined,
  tipSequence: number,
): Promise<Move[]> {
  const moves: Move[] = [];
  let previous = tip;
  for (const [index, from] of moving.entries()) {
    const sequence = String(tipSequence + index + 1).padStart(6, "0");
    // oxlint-disable-next-line eslint/no-await-in-loop -- each file chains onto the one before it.
    const to = await writeMigration(
      from.filename.replace(/^\d+/u, sequence),
      previous,
      from.body,
      from,
    );
    moves.push({ from, to });
    previous = to.hash;
  }
  return moves;
}
