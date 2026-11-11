/** `behind` means the recorded rows are a shorter prefix of the Committed chain. */
export type RecordedChain = "match" | "behind" | "diverged";

/**
 * How the Dev database's recorded rows stand against the Committed chain, compared hash by hash in
 * sequence order. Generate picks its catch-up path by it, and commit requires `match`.
 */
export function compareRecorded(
  recorded: readonly { readonly hash: string }[],
  chain: readonly { readonly hash: string }[],
): RecordedChain {
  const prefix = recorded.every((row, index) => row.hash === chain[index]?.hash);
  if (!prefix) return "diverged";
  return recorded.length === chain.length ? "match" : "behind";
}
