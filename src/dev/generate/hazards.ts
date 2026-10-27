const HAZARD = /^-- hazard: (\S+)\s*$/u;
const HAZARD_LOOKING = /--\s*hazard\s*:/iu;
const TRAILING_COMMENT = /--.*$/u;

export type HazardLine = { readonly kind: string; readonly statement: string };
export type StrayHazardComment = { readonly line: number; readonly text: string };

type Scan = { readonly hazards: HazardLine[]; readonly strays: StrayHazardComment[] };

type ScanState = {
  readonly hazards: HazardLine[];
  readonly strays: StrayHazardComment[];
  kinds: string[];
  kindLines: StrayHazardComment[];
  statement: string[];
  inStatement: boolean;
};

function flush(state: ScanState): void {
  for (const kind of state.kinds) {
    state.hazards.push({ kind, statement: state.statement.join(" ") });
  }
  state.kinds = [];
  state.kindLines = [];
  state.statement = [];
}

function scanLine(state: ScanState, line: string, index: number): void {
  const kind = state.inStatement ? undefined : HAZARD.exec(line)?.[1];
  if (kind !== undefined) {
    state.kinds.push(kind);
    state.kindLines.push({ line: index + 1, text: line });
    return;
  }
  if (HAZARD_LOOKING.test(line)) state.strays.push({ line: index + 1, text: line });
  if (state.kinds.length > 0) state.statement.push(line.trim());
  trackStatement(state, line);
}

function trackStatement(state: ScanState, line: string): void {
  const code = line.replace(TRAILING_COMMENT, "").trim();
  if (code !== "") state.inStatement = true;
  if (state.inStatement && code.endsWith(";")) {
    state.inStatement = false;
    flush(state);
  }
}

function finishScan(state: ScanState): void {
  if (state.inStatement) {
    flush(state);
    return;
  }
  state.strays.push(...state.kindLines);
  state.strays.sort((x, y) => x.line - y.line);
}

function scan(sql: string): Scan {
  const state: ScanState = {
    hazards: [],
    strays: [],
    kinds: [],
    kindLines: [],
    statement: [],
    inStatement: false,
  };
  for (const [index, line] of sql.split("\n").entries()) scanLine(state, line, index);
  finishScan(state);
  return { hazards: state.hazards, strays: state.strays };
}

/**
 * The Hazards a Current migration's body declares: each `-- hazard: <kind>` comment (architecture
 * "Hazards") pairs with the statement under it, which runs from its first line of code to the
 * line whose code ends in `;`. A trailing `--` comment doesn't count toward that end.
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
