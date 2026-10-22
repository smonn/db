import { migrationHash } from "../internal/index.ts";
import type { MigrationFile } from "../ports/index.ts";

/** A Committed migration file whose headers name `previous` and hash the body onto it. */
export async function migrationFile(
  filename: string,
  previous: string | undefined,
  body: string,
): Promise<MigrationFile> {
  return withHeaders(filename, previous, await migrationHash(previous, body), body);
}

/** Committed migration files whose headers chain each hash to the one before it. */
export async function chain(
  ...files: [filename: string, body: string][]
): Promise<MigrationFile[]> {
  const result: MigrationFile[] = [];
  let previous: string | undefined;
  for (const [filename, body] of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each hash covers the one before it.
    const hash = await migrationHash(previous, body);
    result.push(withHeaders(filename, previous, hash, body));
    previous = hash;
  }
  return result;
}

function withHeaders(
  filename: string,
  previous: string | undefined,
  hash: string,
  body: string,
): MigrationFile {
  return { filename, content: `--! Previous: ${previous ?? "-"}\n--! Hash: ${hash}\n\n${body}` };
}
