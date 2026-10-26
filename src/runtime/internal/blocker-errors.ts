/** Where the SQL that Postgres refused came from, which decides who can fix it and how. */
export type BlockerSource =
  | { readonly kind: "generated" }
  | { readonly kind: "hand-edited" }
  | { readonly kind: "committed"; readonly filename: string };

// Postgres words every variant (a view, a rule, a generated column) this way. A column used in a
// policy or trigger says "used in", so it stays unmapped.
const RETYPE_BLOCKED = "cannot alter type of a column used by ";

/**
 * Maps the Postgres errors that mean another object blocks a drop (2BP01) or a column retype
 * (0A000) to a message that names the blockers and the fix. Every other error passes through
 * unchanged. Pure, so generate and `migrate` share it.
 */
export function explainBlockerError(
  error: unknown,
  options: { readonly source: BlockerSource },
): unknown {
  if (!(error instanceof Error)) return error;
  const { code, detail } = error as Error & { code?: unknown; detail?: unknown };
  const blocked =
    code === "2BP01" || (code === "0A000" && error.message.startsWith(RETYPE_BLOCKED));
  if (!blocked) return error;
  const blockers = typeof detail === "string" ? `:\n  ${detail.split("\n").join("\n  ")}` : "";
  return new Error(`${error.message}${blockers}\n${hint(options.source)}`, { cause: error });
}

function hint(source: BlockerSource): string {
  if (source.kind === "committed") {
    return `${source.filename} rolled back. Another object depends on what it changes, and a Committed file is hashed, so fix it in a new migration.`;
  }
  const why =
    source.kind === "generated"
      ? "Generate never uses CASCADE or alters an Unmodeled object, so one blocks it."
      : "An Unmodeled object blocks it.";
  return `${why} Hand edit the Current migration to drop or change that object.`;
}
