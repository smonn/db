import { readCommitted } from "../../runtime/internal/index.ts";
import type { MigrationSource } from "../../runtime/ports/index.ts";
import { nodeFileSystem } from "./file-system.ts";

/**
 * Reads the Committed migrations from the `.sql` files directly inside `directory`, skipping the
 * Current migration. Any other misnamed `.sql` file is kept, so the migrator refuses it loudly.
 */
export function nodeMigrationSource(directory: string): MigrationSource {
  const folder = nodeFileSystem();
  return { list: () => readCommitted(folder, directory) };
}
