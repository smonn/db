import type { FileSystem, MigrationFile } from "../ports/index.ts";
import { committedFilenames } from "./migration-file.ts";

export type MigrationFolder = Pick<FileSystem, "list" | "readFile">;

/**
 * Reads the Committed migrations directly inside `directory`. A misnamed `.sql` file is kept, so
 * the migrator refuses it by name.
 */
export async function readCommitted(
  folder: MigrationFolder,
  directory: string,
): Promise<MigrationFile[]> {
  const filenames = committedFilenames(await folder.list(directory)).toSorted();
  return Promise.all(
    filenames.map(async (filename) => {
      const path = `${directory}/${filename}`;
      const content = await folder.readFile(path);
      if (content === undefined) throw new Error(`${path} vanished between listing and reading`);
      return { filename, content };
    }),
  );
}
