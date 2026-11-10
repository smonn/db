import { hazardsIn, type GenerateResult } from "../generate/index.ts";
import type { SuccessDocument } from "../output/index.ts";

/** What a command hands `main` to print. `generate` prints its own lines until it has a document, and hands over undefined. */
export type Outcome = SuccessDocument | undefined;

/** The lines a command prints without `--json`, for the document it prints with it. */
export function documentLines(document: SuccessDocument): string[] {
  switch (document.command) {
    case "commit":
      return [`wrote ${document.file.path}`];
    case "reset":
      return [resetReport(document)];
    case "migrate":
      return migrateLines(document.applied);
    case "verify":
      return [verifyLine(document.verified.length)];
    case "rebase":
      return rebaseReport(document);
    // Stryker disable next-line ConditionalExpression: 1 survivor: unreachable, since the type forbids any other command.
    default:
      return document satisfies never;
  }
}

/** The lines `generate` prints: the file, each Hazard with its statement, each rename hint, and whether it reset. */
export function generateReport(result: GenerateResult, path: string): string[] {
  const hazards =
    result.sql === undefined
      ? []
      : hazardsIn(result.sql).map(({ kind, statement }) => `hazard ${kind}: ${statement}`);
  const reset = result.reset ? "reset the Dev database" : "left the Dev database as it was";
  const hints = result.hints.map((hint) => `hint: ${hint}`);
  return [...fileLines(result, path), ...hazards, ...hints, reset];
}

function fileLines({ diff, sql, leftover }: GenerateResult, path: string): string[] {
  if (diff === undefined) return [sql === undefined ? `no diff, removed ${path}` : `wrote ${path}`];
  return [
    `kept hand-edited ${path}, replayed as written; diff to what generate would write:`,
    (diff === "" ? "matches what generate would write" : diff).trimEnd(),
    ...(leftover === undefined ? [] : [`warning: ${leftover}`]),
  ];
}

function migrateLines(applied: readonly string[]): string[] {
  return applied.length === 0
    ? ["nothing to apply"]
    : applied.map((filename) => `applied ${filename}`);
}

function verifyLine(count: number): string {
  return `verified ${count} ${count === 1 ? "migration" : "migrations"}`;
}

function resetReport({ committed, current }: { committed: number; current: boolean }): string {
  const replayed = `${committed} Committed ${committed === 1 ? "migration" : "migrations"}`;
  return `reset the Dev database from ${current ? `${replayed} and current.sql` : replayed}`;
}

/** The lines `rebase` prints: each file it rewrote, and how to catch up a Dev database. */
function rebaseReport({ moved, onto }: Extract<SuccessDocument, { command: "rebase" }>): string[] {
  if (moved.length === 0) return [`nothing to rebase onto ${onto}`];
  return [
    ...moved.map(({ from, to }) => `rewrote ${from} as ${to}`),
    "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset",
  ];
}
