import { explainBlockerError } from "../../runtime/internal/index.ts";

/** The fix for a Postgres error code, worded for SQL that generate wrote and for a hand edit. */
const FIXES: Readonly<Record<string, { readonly generated: string; readonly handEdited: string }>> =
  {
    // A retype with no USING raises this, and so does a default that can't be cast, so the hint offers both fixes.
    "42804": {
      generated:
        "Generate writes a plain ALTER COLUMN ... TYPE with no USING and leaves defaults alone. Hand edit the Current migration to add a USING clause or change the column's default.",
      handEdited:
        "Add a USING clause to the ALTER COLUMN ... TYPE, or change the column's default, in the Current migration.",
    },
    // A new enum label can't be used before its transaction commits, and a migration is one transaction.
    "55P04": {
      generated:
        "Generate adds the label with ALTER TYPE ... ADD VALUE, and a later statement in the same migration uses it. Remove the use from the Definition, commit the migration that adds the label, then use it in the next migration.",
      handEdited:
        "The Current migration adds an enum label and uses it in one transaction. Commit the label, then use it in the next migration.",
    },
  };

/**
 * Maps a Postgres error raised while applying SQL to the Shadow database to a message that names
 * what blocked it and what to do (ADR-0013). Other errors pass through unchanged. `handEdited`
 * words the hint for a hand-edited `current.sql`, which generate did not write.
 */
export function explainShadowError(
  error: unknown,
  options: { readonly handEdited?: boolean | undefined } = {},
): unknown {
  const handEdited = options.handEdited ?? false;
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const fix = typeof code === "string" && Object.hasOwn(FIXES, code) ? FIXES[code] : undefined;
  if (error instanceof Error && fix !== undefined) {
    return new Error(`${error.message}\n${handEdited ? fix.handEdited : fix.generated}`, {
      cause: error,
    });
  }
  return explainBlockerError(error, {
    source: { kind: handEdited ? "hand-edited" : "generated" },
  });
}
