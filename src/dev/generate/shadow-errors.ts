/**
 * Maps a Postgres error raised while applying SQL to the Shadow database to a message that names
 * what blocked it and what to do (ADR-0013). Other errors pass through unchanged.
 */
export function explainShadowError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, detail } = error as Error & { code?: unknown; detail?: unknown };
  if (code === "2BP01") {
    const blockers = typeof detail === "string" ? detail.split("\n") : [];
    return new Error(
      `${error.message}; generate never uses CASCADE, so an Unmodeled object blocks it:\n${blockers
        .map((line) => `  ${line}`)
        .join("\n")}\nDrop or change the Unmodeled object by hand in the Current migration.`,
      { cause: error },
    );
  }
  if (code === "42804") {
    return new Error(
      `${error.message}; a type change is a plain ALTER COLUMN ... TYPE with no USING. Edit the Current migration by hand to add the USING clause.`,
      { cause: error },
    );
  }
  return error;
}
