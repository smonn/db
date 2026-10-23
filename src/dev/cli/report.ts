import { hazardsIn, type GenerateResult, type ResetResult } from "../generate/index.ts";

/** The lines `generate` prints: the file, each Hazard with its statement, and whether it reset. */
export function generateReport(result: GenerateResult, path: string): string[] {
  const hazards = hazardsIn(result.sql ?? "").map(
    ({ kind, statement }) => `hazard ${kind}: ${statement}`,
  );
  const reset = result.reset ? "reset the Dev database" : "left the Dev database as it was";
  return [...fileLines(result, path), ...hazards, reset];
}

function fileLines({ diff, sql, leftover }: GenerateResult, path: string): string[] {
  if (diff === undefined) return [sql === undefined ? `no diff, removed ${path}` : `wrote ${path}`];
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
