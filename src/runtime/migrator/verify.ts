import { migrationHash, parseMigration, type ParsedMigration } from "../internal/index.ts";
import type { MigrationSource } from "../ports/index.ts";

export type VerifyResult = {
  readonly verified: readonly string[];
};

/**
 * Checks the Committed migrations' hash chain without a database. Throws, naming the file, on a
 * gap or repeat in the sequence, a Previous that isn't the prior file's Hash, or a changed body.
 */
export async function verify(source: MigrationSource): Promise<VerifyResult> {
  const migrations = await loadVerifiedMigrations(source);
  return { verified: migrations.map(({ filename }) => filename) };
}

export type RecordedMigration = {
  readonly filename: string;
  readonly hash: string;
};

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

  const actualHashes = await Promise.all(
    migrations.map((migration) => migrationHash(migration.previous, migration.body)),
  );
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.sequence > expected) {
      throw new Error(`${migration.filename}: sequence ${expected} is missing before it`);
    }
    if (migration.sequence < expected) {
      throw new Error(`${migration.filename}: repeats sequence ${migration.sequence}`);
    }
    const previous = migrations[index - 1]?.hash;
    if (migration.previous !== previous) {
      throw new Error(
        `${migration.filename}: --! Previous should be ${previous ?? "-"}, not ${migration.previous ?? "-"}`,
      );
    }
    const actual = actualHashes[index];
    if (actual !== migration.hash) {
      throw new Error(
        `${migration.filename}: --! Hash says ${migration.hash} but the body hashes to ${actual}`,
      );
    }
  });
  return migrations;
}
