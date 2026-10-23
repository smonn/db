const HAZARD = /^-- hazard: (\S+)\s*$/u;

export type HazardLine = { readonly kind: string; readonly statement: string };

/**
 * The Hazards a Current migration's body declares: each `-- hazard: <kind>` comment (architecture
 * "Hazards") pairs with the statement under it, which runs to the next line ending in `;`.
 */
export function hazardsIn(sql: string): HazardLine[] {
  const lines = sql.split("\n");
  const found: HazardLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const kinds: string[] = [];
    for (let match = HAZARD.exec(lines[i] ?? ""); match !== null;) {
      kinds.push(match[1] ?? "");
      i++;
      match = HAZARD.exec(lines[i] ?? "");
    }
    if (kinds.length === 0) continue;
    const statement: string[] = [];
    for (; i < lines.length; i++) {
      const line = lines[i] ?? "";
      statement.push(line.trim());
      if (line.trimEnd().endsWith(";")) break;
    }
    for (const kind of kinds) found.push({ kind, statement: statement.join(" ") });
  }
  return found;
}
