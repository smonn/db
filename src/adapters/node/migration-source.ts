import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationSource } from "../../runtime/ports/index.ts";

/** Reads the Committed migrations from the `.sql` files directly inside `directory`. */
export function nodeMigrationSource(directory: string): MigrationSource {
  return {
    async list() {
      const entries = await readdir(directory, { withFileTypes: true });
      const filenames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
        .map((entry) => entry.name)
        .toSorted();
      return Promise.all(
        filenames.map(async (filename) => ({
          filename,
          content: await readFile(join(directory, filename), "utf8"),
        })),
      );
    },
  };
}
