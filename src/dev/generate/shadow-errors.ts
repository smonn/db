import { explainBlockerError } from "../../runtime/internal/index.ts";

/**
 * Maps a Postgres error raised while applying SQL to the Shadow database to a message that names
 * what blocked it and what to do (ADR-0013). Other errors pass through unchanged. `handEdited`
 * words the hint for a hand-edited `current.sql`, which generate did not write. `noTransaction`
 * says the file carries the `--! no-transaction` header (ADR-0020).
 */
export function explainShadowError(
  error: unknown,
  options: {
    readonly handEdited?: boolean | undefined;
    readonly noTransaction?: boolean | undefined;
  } = {},
): unknown {
  const handEdited = options.handEdited ?? false;
  if (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "25001" &&
    options.noTransaction !== true
  ) {
    // The Shadow runs a file without the header in a transaction, which a statement such as CREATE INDEX CONCURRENTLY refuses.
    return Object.assign(
      new Error(
        `${error.message}\nIf the statement can't run in a transaction, add \`--! no-transaction\` as the first line of the Current migration (ADR-0020).`,
        { cause: error },
      ),
      { code: "25001" },
    );
  }
  if (error instanceof Error && (error as Error & { code?: unknown }).code === "42804") {
    // A retype with no USING raises this, and so does a default that can't be cast, so the hint offers both fixes.
    const fix = handEdited
      ? "Add a USING clause to the ALTER COLUMN ... TYPE, or change the column's default, in the Current migration."
      : "Generate writes a plain ALTER COLUMN ... TYPE with no USING and leaves defaults alone. Hand edit the Current migration to add a USING clause or change the column's default.";
    return new Error(`${error.message}\n${fix}`, { cause: error });
  }
  return explainBlockerError(error, {
    source: { kind: handEdited ? "hand-edited" : "generated" },
  });
}
