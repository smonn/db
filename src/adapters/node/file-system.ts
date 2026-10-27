import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileSystem } from "../../runtime/ports/index.ts";

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

export function nodeFileSystem(): FileSystem {
  return {
    async readFile(path) {
      let content: string | undefined;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return content;
    },
    async writeFile(path, content) {
      await writeFile(path, content);
    },
    async list(directory) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) {
          throw new Error(`the folder ${directory} doesn't exist`, { cause: error });
        }
        throw error;
      }
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    async mkdir(directory) {
      await mkdir(directory, { recursive: true });
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async rename(from, to) {
      await rename(from, to);
    },
  };
}
