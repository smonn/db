const HAZARD = /^-- hazard: (\S+)\s*$/u;
const HAZARD_LOOKING = /--+\s*hazard\s*:/iu;

export type HazardLine = { readonly kind: string; readonly statement: string };
export type StrayHazardComment = { readonly line: number; readonly text: string };

type Scan = { readonly hazards: HazardLine[]; readonly strays: StrayHazardComment[] };

function scan(sql: string): Scan {
  const hazards: HazardLine[] = [];
  const strays: StrayHazardComment[] = [];
  let kinds: string[] = [];
  let kindLines: number[] = [];
  let statement: string[] = [];
  const flush = (): void => {
    for (const kind of kinds) hazards.push({ kind, statement: statement.join(" ") });
    kinds = [];
    kindLines = [];
    statement = [];
  };
  const lines = sql.split("\n");
  for (const [index, line] of lines.entries()) {
    const kind = statement.length === 0 ? HAZARD.exec(line)?.[1] : undefined;
    if (kind !== undefined) {
      kinds.push(kind);
      kindLines.push(index);
      continue;
    }
    if (HAZARD_LOOKING.test(line)) strays.push({ line: index + 1, text: line });
    if (kinds.length > 0) {
      statement.push(line.trim());
      if (line.trimEnd().endsWith(";")) flush();
    }
  }
  if (!statement.some((text) => text !== "")) {
    for (const index of kindLines) strays.push({ line: index + 1, text: lines[index] ?? "" });
    strays.sort((a, b) => a.line - b.line);
  }
  if (kinds.length > 0) flush();
  return { hazards, strays };
}

/**
 * The Hazards a Current migration's body declares: each `-- hazard: <kind>` comment (architecture
 * "Hazards") pairs with the statement under it, which runs to the next line ending in `;`.
 */
export function hazardsIn(sql: string): HazardLine[] {
  return scan(sql).hazards;
}

/**
 * The lines that look like a Hazard comment (`--`, then `hazard:`, any case or spacing) but
 * don't pair with a statement as one: indented, unspaced, recased, trailing, inside a statement,
 * or with no statement under it. `hazards` (plural) never looks like one.
 */
export function strayHazardComments(sql: string): StrayHazardComment[] {
  return scan(sql).strays;
}
