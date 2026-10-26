import { CURRENT_FILENAME } from "../../runtime/internal/index.ts";
import { HAZARD_KINDS } from "../diff/index.ts";
import { hazardsIn, strayHazardComments } from "./hazards.ts";

const KNOWN: readonly string[] = HAZARD_KINDS;

/**
 * Why `commit` refuses (ADR-0015), or undefined when `accepted` names every Hazard kind in the
 * Current migration's body. It groups the missing kinds by statement and prints the full
 * `--accept` flag to pass. A kind that isn't one of ours is a typo in a hand edit, so the refusal
 * names it apart from the flag, which could never accept it. A line that looks like a Hazard
 * comment but isn't read as one would drop its gate by accident, so it refuses too.
 */
export function hazardRefusal(body: string, accepted: readonly string[]): string | undefined {
  const { missing, unknown } = groupHazards(body, accepted);
  const strays = strayHazardComments(body);
  if (missing.size === 0 && unknown.size === 0 && strays.length === 0) return undefined;
  return refusalLines(missing, unknown, strays, accepted).join("\n");
}

function refusalLines(
  missing: ReadonlyMap<string, string[]>,
  unknown: ReadonlySet<string>,
  strays: readonly { line: number; text: string }[],
  accepted: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const { line, text } of strays) {
    lines.push(
      `${CURRENT_FILENAME}:${line} looks like a Hazard comment but isn't one: ${JSON.stringify(text)}; use "-- hazard: <kind>" above a statement or delete the line`,
    );
  }
  if (missing.size > 0) {
    lines.push(`${CURRENT_FILENAME} has Hazards that --accept doesn't name:`);
    for (const [statement, kinds] of missing) lines.push(`  ${kinds.join(", ")}: ${statement}`);
  }
  for (const kind of unknown) {
    lines.push(
      `unknown Hazard kind ${JSON.stringify(kind)} in ${CURRENT_FILENAME}; fix or delete the comment`,
    );
  }
  if (missing.size > 0) lines.push(acceptHint(accepted, missing));
  return lines;
}

function acceptHint(accepted: readonly string[], missing: ReadonlyMap<string, string[]>): string {
  const flag = new Set([...accepted, ...[...missing.values()].flat()]);
  return `to commit anyway, pass --accept ${[...flag].join(",")}`;
}

function groupHazards(
  body: string,
  accepted: readonly string[],
): { missing: Map<string, string[]>; unknown: Set<string> } {
  const missing = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const { kind, statement } of hazardsIn(body)) {
    if (!KNOWN.includes(kind)) unknown.add(kind);
    else if (!accepted.includes(kind)) {
      const kinds = missing.get(statement);
      if (kinds === undefined) missing.set(statement, [kind]);
      else kinds.push(kind);
    }
  }
  return { missing, unknown };
}
