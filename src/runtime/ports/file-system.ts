/** Paths are `/`-separated and passed through as given. */
export type FileSystem = {
  /** `undefined` when the file doesn't exist. */
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, content: string): Promise<void>;
  /** The names of the files directly inside `directory`, without the directory. */
  list(directory: string): Promise<readonly string[]>;
  /** Creates `directory` and its parents, doing nothing when it exists. */
  mkdir(directory: string): Promise<void>;
  /** Does nothing when the file doesn't exist. */
  remove(path: string): Promise<void>;
  /** Moves a file to `to` in one step, replacing any file there. */
  rename(from: string, to: string): Promise<void>;
};
