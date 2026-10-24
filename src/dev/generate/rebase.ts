import {
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
 * Hash, and the moving files chain onto each other from a file the base ref holds.
 */
export async function rebase(options: RebaseOptions): Promise<RebaseResult> {
  const { fileSystem, migrations, onto } = options;
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
      `${migrations} may be half-rewritten (${message}); restore it from git with git checkout -- ${migrations}`,
      { cause: error },
    );
  }
  return { moved: moves.map(({ from, to }) => ({ from: from.filename, to: to.filename })) };
}

/**
 * Writes each move one at a time. Before a move overwrites another moving file's old name, that
 * file is written under its own new name, so a failed write never loses a body.
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
    await fileSystem.writeFile(`${migrations}/${move.to.filename}`, move.to.content);
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
    moving.map((migration) => migrationHash(migration.previous, migration.body)),
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
    const to = await writeMigration(from.filename.replace(/^\d+/u, sequence), previous, from.body);
    moves.push({ from, to });
    previous = to.hash;
  }
  return moves;
}
