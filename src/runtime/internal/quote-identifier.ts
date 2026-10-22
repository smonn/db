/** Double-quotes a name as a SQL identifier, doubling each embedded `"`. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
