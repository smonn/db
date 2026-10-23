/**
 * Maps a Postgres error raised while applying SQL to the Shadow database to a message that names
 * what blocked it and what to do (ADR-0013). Other errors pass through unchanged. `handEdited`
 * words the hint for a hand-edited `current.sql`, which generate did not write.
 */
export function explainShadowError(error: unknown, handEdited = false): unknown {
  if (!(error instanceof Error)) return error;
  const { code, detail } = error as Error & { code?: unknown; detail?: unknown };
  if (code === "2BP01") {
    const blockers = typeof detail === "string" ? detail.split("\n") : [];
    const why = handEdited
      ? "an Unmodeled object blocks it"
      : "generate never uses CASCADE, so an Unmodeled object blocks it";
    return new Error(
      `${error.message}; ${why}:\n${blockers
        .map((line) => `  ${line}`)
        .join("\n")}\nDrop or change the Unmodeled object by hand in the Current migration.`,
      { cause: error },
    );
  }
  if (code === "42804") {
    const fix = handEdited
      ? "add the USING clause to the ALTER COLUMN ... TYPE in the Current migration."
      : "a type change is a plain ALTER COLUMN ... TYPE with no USING. Edit the Current migration by hand to add the USING clause.";
    return new Error(`${error.message}; ${fix}`, { cause: error });
  }
  if (
    code === "0A000" &&
    error.message.startsWith("cannot alter type of a column used by a view")
  ) {
    const why = typeof detail === "string" ? `:\n  ${detail.split("\n").join("\n  ")}` : "";
    const fix = handEdited
      ? "drop or change the view by hand in the Current migration."
      : "generate never alters a view. Drop or change the view by hand in the Current migration.";
    return new Error(`${error.message}${why}\n${fix}`, { cause: error });
  }
  return error;
}
