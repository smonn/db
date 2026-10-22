import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { committedFilenames } from "../../runtime/internal/index.ts";
import type { MigrationSource } from "../../runtime/ports/index.ts";

/**
 * Reads the Committed migrations from the `.sql` files directly inside `directory`, skipping the
 * Current migration. Any other misnamed `.sql` file is kept, so the migrator refuses it loudly.
 */
export function nodeMigrationSource(directory: string): MigrationSource {
  return {
    async list() {
      const entries = await readdir(directory, { withFileTypes: true });
      const filenames = committedFilenames(
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      ).toSorted();
      return Promise.all(
        filenames.map(async (filename) => ({
          filename,
          content: await readFile(join(directory, filename), "utf8"),
        })),
      );
    },
  };
}
