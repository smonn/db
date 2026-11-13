import type { GeneratedFiles, GenerateResult } from "../generate/index.ts";
import {
  generateDocument,
  type GenerateDocument,
  type RebaseDocument,
  type SuccessDocument,
} from "../output/index.ts";

/** The lines a command prints without `--json`, for the document it prints with it. */
export function documentLines(document: SuccessDocument): string[] {
  return document.command === "generate" ? generateLines(document) : otherLines(document);
}

function otherLines(document: Exclude<SuccessDocument, GenerateDocument>): string[] {
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

/** The lines `generate --watch` prints for one run, as one-shot `generate` prints them. */
export function generateReport(result: GenerateResult, path: string): string[] {
  return generateLines(generateDocument(result, path));
}

/** The lines for what `generate` settled in the files, which a failed catch-up still prints. */
export function generatedLines(files: GeneratedFiles, path: string): string[] {
  return generateReport({ ...files, devDatabase: { kind: "none" } }, path);
}

/**
 * The lines `generate` prints: the file, each Hazard with its statement, each rename hint, then
 * what it did to the Dev database, if anything. A generated file it kept as it was printed its
 * Hazards and hints on the run that wrote it, so a run that changes nothing stays silent; the
 * document keeps them.
 */
function generateLines({ file, hazards, hints, devDatabase }: GenerateDocument): string[] {
  const unchanged = !file.handEdited && (file.action === "kept" || file.action === "absent");
  return [
    ...fileLines(file),
    ...(unchanged ? [] : hazards.map(({ kind, statement }) => `hazard ${kind}: ${statement}`)),
    ...(unchanged ? [] : hints.map((hint) => `hint: ${hint}`)),
    ...outcomeLines(devDatabase),
  ];
}

/** One line for what generate did to the Dev database, if anything, then each Hazard it replayed. */
function outcomeLines(outcome: GenerateDocument["devDatabase"]): string[] {
  switch (outcome.kind) {
    case "none":
      return [];
    case "reset":
      return ["reset the Dev database"];
    case "replayed":
      return [
        `replayed ${outcome.files.join(", ")} into the Dev database`,
        ...outcome.hazards.map(
          ({ file, kind, statement }) => `hazard ${kind} in ${file}: ${statement}`,
        ),
      ];
    case "diffed":
      return [
        outcome.skipped.length === 0
          ? "diffed the Dev database to the files"
          : `diffed the Dev database to the files, skipping replay of ${outcome.skipped.join(", ")}`,
        ...outcome.hazards.map(
          ({ kind, statement }) => `hazard ${kind} in the Dev database: ${statement}`,
        ),
      ];
    // Stryker disable next-line ConditionalExpression: 1 survivor: unreachable, since the type forbids any other kind.
    default:
      return outcome satisfies never;
  }
}

function fileLines({ path, action, ...edit }: GenerateDocument["file"]): string[] {
  return edit.handEdited ? handEditLines(path, edit) : generatedFileLines(path, action);
}

function generatedFileLines(path: string, action: GenerateDocument["file"]["action"]): string[] {
  if (action === "kept" || action === "absent") return [];
  return [action === "removed" ? `no diff, removed ${path}` : `wrote ${path}`];
}

function handEditLines(
  path: string,
  { diff, leftover }: { readonly diff: string; readonly leftover?: string },
): string[] {
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
function rebaseReport({ moved, onto }: RebaseDocument): string[] {
  if (moved.length === 0) return [`nothing to rebase onto ${onto}`];
  return [
    ...moved.map(({ from, to }) => `rewrote ${from} as ${to}`),
    "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset",
  ];
}
