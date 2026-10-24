import type { ParsedMigration } from "../internal/index.ts";

/** Two or more Committed migrations that name the same parent in `--! Previous:`. */
export type Fork = {
  /** The file whose Hash is `previous`: `undefined` at the start of the chain or when no file has it. */
  readonly parent: ParsedMigration | undefined;
  /** The shared `--! Previous:` value, `undefined` for files that start the chain. */
  readonly previous: string | undefined;
  /** The first file of each branch, by sequence then filename. */
  readonly successors: readonly ParsedMigration[];
};

function bySequence(a: ParsedMigration, b: ParsedMigration): number {
  return a.sequence - b.sequence || (a.filename < b.filename ? -1 : 1);
}

/**
 * Finds every parent that more than one file follows, as two branches do when each commits a
 * Migration on the same tip. Reads `--! Previous:` only, so it holds when sequences repeat. Forks
 * come in the order of their parents' sequence.
 */
export function findForks(migrations: readonly ParsedMigration[]): Fork[] {
  const forks: Fork[] = [];
  for (const [previous, group] of Map.groupBy(migrations, (migration) => migration.previous)) {
    if (group.length < 2) continue;
    forks.push({
      parent: migrations.find(({ hash }) => hash === previous),
      previous,
      successors: group.toSorted(bySequence),
    });
  }
  return forks.toSorted((a, b) => (a.parent?.sequence ?? 0) - (b.parent?.sequence ?? 0));
}
