import { hazardsIn, type GeneratedFiles, type GenerateResult } from "../generate/index.ts";
import type { GeneratedPart, GenerateDocument } from "./document.ts";

/**
 * The document `generate --json` prints for a run. `path` is `current.sql` as the document names it,
 * relative to the working directory. A reusable builder, since `generate --watch` embeds the same
 * document in each run's event (ADR-0032).
 */
export function generateDocument(result: GenerateResult, path: string): GenerateDocument {
  return {
    command: "generate",
    ok: true,
    ...generatedPart(result, path),
    devDatabase: result.devDatabase,
  };
}

/** What the files settled: the part of the document a failed catch-up still has. */
export function generatedPart(files: GeneratedFiles, path: string): GeneratedPart {
  const { diff, leftover } = files;
  const edit =
    diff === undefined
      ? ({ handEdited: false } as const)
      : ({ handEdited: true, diff, ...(leftover === undefined ? {} : { leftover }) } as const);
  return {
    file: { path, action: files.file, ...edit },
    hazards: files.sql === undefined ? [] : hazardsIn(files.sql),
    hints: files.hints,
  };
}
