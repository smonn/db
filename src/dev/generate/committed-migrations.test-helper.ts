import { migrationHash } from "../../runtime/internal/index.ts";
import type { MigrationFile } from "../../runtime/ports/index.ts";

/** Committed migration files whose headers chain each hash to the one before it. */
export async function chain(
  ...files: [filename: string, body: string][]
): Promise<MigrationFile[]> {
  const result: MigrationFile[] = [];
  let previous: string | undefined;
  for (const [filename, body] of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each hash covers the one before it.
    const hash = await migrationHash(previous, body);
    result.push({
      filename,
      content: `--! Previous: ${previous ?? "-"}\n--! Hash: ${hash}\n\n${body}`,
    });
    previous = hash;
  }
  return result;
}

/** Keys each file by its path under `directory`, the shape `memoryFileSystem` takes. */
export function filesIn(
  directory: string,
  files: readonly MigrationFile[],
): Record<string, string> {
  return Object.fromEntries(files.map((file) => [`${directory}/${file.filename}`, file.content]));
}
