import type { GenerateResult, ResetResult } from "../generate/index.ts";
import { hazardsIn } from "./hazards.ts";

/** The lines `generate` prints: the file, each Hazard with its statement, and whether it reset. */
export function generateReport(result: GenerateResult, path: string): string[] {
  const hazards = hazardsIn(result.sql ?? "").map(
    ({ kind, statement }) => `hazard ${kind}: ${statement}`,
  );
  const reset = result.reset ? "reset the Dev database" : "left the Dev database as it was";
  return [...fileLines(result, path), ...hazards, reset];
}

function fileLines({ diff, sql }: GenerateResult, path: string): string[] {
  if (diff === undefined) return [sql === undefined ? `no diff, removed ${path}` : `wrote ${path}`];
  return [
    `kept hand-edited ${path}, replayed as written; diff to what generate would write:`,
    (diff === "" ? "matches what generate would write" : diff).trimEnd(),
  ];
}

export function resetReport({ committed, current }: ResetResult): string {
  const replayed = `${committed} Committed ${committed === 1 ? "migration" : "migrations"}`;
  return `reset the Dev database from ${current ? `${replayed} and current.sql` : replayed}`;
}

/**
 * Why `commit` refuses (ADR-0015), or undefined when `accepted` names every Hazard kind in the
 * Current migration's body. It groups the missing kinds by statement and prints the full
 * `--accept` flag to pass.
 */
export function hazardRefusal(body: string, accepted: readonly string[]): string | undefined {
  const missing = new Map<string, string[]>();
  for (const { kind, statement } of hazardsIn(body)) {
    if (accepted.includes(kind)) continue;
    const kinds = missing.get(statement);
    if (kinds === undefined) missing.set(statement, [kind]);
    else kinds.push(kind);
  }
  if (missing.size === 0) return undefined;
  const flag = new Set([...accepted, ...[...missing.values()].flat()]);
  return [
    "current.sql has Hazards that --accept doesn't name:",
    ...[...missing].map(([statement, kinds]) => `  ${kinds.join(", ")}: ${statement}`),
    `to commit anyway, pass --accept ${[...flag].join(",")}`,
  ].join("\n");
}
