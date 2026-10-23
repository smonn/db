const HAZARD = /^-- hazard: (\S+)\s*$/u;

export type HazardLine = { readonly kind: string; readonly statement: string };

/**
 * The Hazards a Current migration's body declares: each `-- hazard: <kind>` comment (architecture
 * "Hazards") pairs with the statement under it, which runs to the next line ending in `;`.
 */
export function hazardsIn(sql: string): HazardLine[] {
  const found: HazardLine[] = [];
  let kinds: string[] = [];
  let statement: string[] = [];
  const flush = (): void => {
    for (const kind of kinds) found.push({ kind, statement: statement.join(" ") });
    kinds = [];
    statement = [];
  };
  for (const line of sql.split("\n")) {
    const kind = statement.length === 0 ? HAZARD.exec(line)?.[1] : undefined;
    if (kind !== undefined) {
      kinds.push(kind);
    } else if (kinds.length > 0) {
      statement.push(line.trim());
      if (line.trimEnd().endsWith(";")) flush();
    }
  }
  if (kinds.length > 0) flush();
  return found;
}
