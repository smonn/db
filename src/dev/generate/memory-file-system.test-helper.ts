import type { FileSystem, MigrationFile } from "../../runtime/ports/index.ts";

export type MemoryFileSystem = FileSystem & {
  readonly files: Map<string, string>;
};

/** A FileSystem held in a Map, where a directory exists once anything is written under it. */
export function memoryFileSystem(initial: Record<string, string> = {}): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: (path) => Promise.resolve(files.get(path)),
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    list: (directory) =>
      Promise.resolve(
        [...files.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => path.slice(directory.length + 1))
          .filter((name) => !name.includes("/")),
      ),
    mkdir: () => Promise.resolve(),
    remove: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const content = files.get(from);
      if (content === undefined) return Promise.reject(new Error(`${from} doesn't exist`));
      files.delete(from);
      files.set(to, content);
      return Promise.resolve();
    },
  };
}

/** Keys each file by its path under `directory`, the shape `memoryFileSystem` takes. */
export function filesIn(
  directory: string,
  files: readonly MigrationFile[],
): Record<string, string> {
  return Object.fromEntries(files.map((file) => [`${directory}/${file.filename}`, file.content]));
}
