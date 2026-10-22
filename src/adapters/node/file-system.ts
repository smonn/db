import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { FileSystem } from "../../runtime/ports/index.ts";

export function nodeFileSystem(): FileSystem {
  return {
    async readFile(path) {
      let content: string | undefined;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return content;
    },
    async writeFile(path, content) {
      await writeFile(path, content, "utf8");
    },
    async list(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    async mkdir(directory) {
      await mkdir(directory, { recursive: true });
    },
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}
