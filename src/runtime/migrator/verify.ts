import {
  migrationHash,
  parseMigration,
  type ParsedMigration,
  type RecordedMigration,
} from "../internal/index.ts";
import type { MigrationSource } from "../ports/index.ts";
import { findForks, type Fork } from "./fork.ts";

export type VerifyResult = {
  readonly verified: readonly string[];
};

/**
 * Checks the Committed migrations' hash chain without a database. Throws on the first problem.
 * A fork names its files. A gap or repeat in the sequence names the file. So does a Previous that
 * isn't the prior file's Hash, and so does a changed body.
 */
export async function verify(source: MigrationSource): Promise<VerifyResult> {
  const migrations = await loadVerifiedMigrations(source);
  return { verified: migrations.map(({ filename }) => filename) };
}

/**
 * Requires the recorded rows, in sequence order, to be a prefix of the file chain. Hashes alone
 * decide a match, so renaming a recorded file's slug is allowed.
 */
export function checkRecorded(
  migrations: readonly ParsedMigration[],
  recorded: readonly RecordedMigration[],
): void {
  recorded.forEach((row, index) => {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new Error(`${row.filename}: recorded as ${row.hash} but has no file`);
    }
    if (migration.hash === row.hash) return;
    if (migration.filename === row.filename) {
      throw new Error(
        `${row.filename}: recorded as ${row.hash} but now hashes to ${migration.hash}`,
      );
    }
    throw new Error(
      `${migration.filename}: stands where the recorded ${row.filename} (${row.hash}) was`,
    );
  });
}

export async function loadVerifiedMigrations(source: MigrationSource): Promise<ParsedMigration[]> {
  const migrations = (await source.list())
    .map((file) => parseMigration(file))
    .toSorted((a, b) => a.sequence - b.sequence);

  const [fork] = findForks(migrations);
  if (fork !== undefined) throw new Error(describeFork(fork));

  const actualHashes = await Promise.all(
    migrations.map((migration) => migrationHash(migration.previous, migration.body, migration)),
  );
  migrations.forEach((migration, index) => {
    checkSequence(migration, index + 1);
    checkChained(migration, migrations[index - 1]?.hash);
    checkHash(migration, actualHashes[index]);
  });
  return migrations;
}

function checkSequence(migration: ParsedMigration, expected: number): void {
  if (migration.sequence > expected) {
    throw new Error(`${migration.filename}: sequence ${expected} is missing before it`);
  }
  if (migration.sequence < expected) {
    throw new Error(`${migration.filename}: repeats sequence ${migration.sequence}`);
  }
}

function checkChained(migration: ParsedMigration, previous: string | undefined): void {
  if (migration.previous !== previous) {
    throw new Error(
      `${migration.filename}: --! Previous should be ${shown(previous)}, not ${shown(migration.previous)}`,
    );
  }
}

function shown(hash: string | undefined): string {
  return hash ?? "-";
}

function checkHash(migration: ParsedMigration, actual: string | undefined): void {
  if (actual !== migration.hash) {
    throw new Error(
      `${migration.filename}: --! Hash says ${migration.hash} but the body hashes to ${actual}`,
    );
  }
}

function describeFork({ parent, previous, successors }: Fork): string {
  const names = successors.map(({ filename }) => filename);
  const last = names.pop();
  const files = `${names.join(", ")} and ${last}`;
  const verb = successors.length === 2 ? "both" : "all";
  if (previous === undefined) return `forked chain: ${files} ${verb} start the chain`;
  return `forked chain: ${files} ${verb} follow ${parent?.filename ?? previous}`;
}
