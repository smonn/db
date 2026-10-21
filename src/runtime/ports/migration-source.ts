export type MigrationFile = {
  /** The file's name without a directory, such as `000001-create-users.sql`. */
  readonly filename: string;
  readonly content: string;
};

/** Read-only, so Committed migrations can come from disk, a bundle, or memory. */
export type MigrationSource = {
  /** Every Committed migration, in any order. */
  list(): Promise<readonly MigrationFile[]>;
};
