import { readdir, readFile } from "node:fs/promises";
import { readCommitted, type MigrationFolder } from "../../runtime/internal/index.ts";
import type { MigrationSource } from "../../runtime/ports/index.ts";

const nodeFolder: MigrationFolder = {
  async list(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  },
  async readFile(path) {
    let content: string | undefined;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return content;
  },
};

/**
 * Reads the Committed migrations from the `.sql` files directly inside `directory`, skipping the
 * Current migration. Any other misnamed `.sql` file is kept, so the migrator refuses it loudly.
 */
export function nodeMigrationSource(directory: string): MigrationSource {
  return { list: () => readCommitted(nodeFolder, directory) };
}
