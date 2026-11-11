import {
  hazardsIn,
  type GenerateResult,
  type RebaseResult,
  type ResetResult,
} from "../generate/index.ts";

/**
 * The lines `generate` prints: the file, each Hazard with its statement, each rename hint, then
 * what it did to the Dev database, if anything. A generated file it kept as it was printed its
 * Hazards and hints on the run that wrote it, so a run that changes nothing stays silent.
 */
export function generateReport(result: GenerateResult, path: string): string[] {
  const unchanged = result.file === "kept" && result.diff === undefined;
  const hazards =
    result.sql === undefined || unchanged
      ? []
      : hazardsIn(result.sql).map(({ kind, statement }) => `hazard ${kind}: ${statement}`);
  const hints = unchanged ? [] : result.hints.map((hint) => `hint: ${hint}`);
  return [...fileLines(result, path), ...hazards, ...hints, ...outcomeLines(result.devDatabase)];
}

/** One line for what generate did to the Dev database, if anything, then each Hazard it replayed. */
function outcomeLines(outcome: GenerateResult["devDatabase"]): string[] {
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

function fileLines({ diff, file, leftover }: GenerateResult, path: string): string[] {
  if (diff === undefined) {
    if (file === "kept") return [];
    return [file === "removed" ? `no diff, removed ${path}` : `wrote ${path}`];
  }
  return [
    `kept hand-edited ${path}, replayed as written; diff to what generate would write:`,
    (diff === "" ? "matches what generate would write" : diff).trimEnd(),
    ...(leftover === undefined ? [] : [`warning: ${leftover}`]),
  ];
}

export function resetReport({ committed, current }: ResetResult): string {
  const replayed = `${committed} Committed ${committed === 1 ? "migration" : "migrations"}`;
  return `reset the Dev database from ${current ? `${replayed} and current.sql` : replayed}`;
}

/** The lines `rebase` prints: each file it rewrote, and how to catch up a Dev database. */
export function rebaseReport({ moved }: RebaseResult, onto: string): string[] {
  if (moved.length === 0) return [`nothing to rebase onto ${onto}`];
  return [
    ...moved.map(({ from, to }) => `rewrote ${from} as ${to}`),
    "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset",
  ];
}
