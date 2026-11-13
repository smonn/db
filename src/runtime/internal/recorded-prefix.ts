/**
 * How many leading recorded rows match the chain hash by hash, in sequence order. The migrator's
 * check, generate's catch-up path, and commit's check each stop where this stops.
 */
export function matchingPrefix(
  recorded: readonly { readonly hash: string }[],
  chain: readonly { readonly hash: string }[],
): number {
  const differs = recorded.findIndex((row, index) => row.hash !== chain[index]?.hash);
  return differs === -1 ? recorded.length : differs;
}
