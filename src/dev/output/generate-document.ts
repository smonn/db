import { hazardsIn, type GenerateResult } from "../generate/index.ts";
import type { GenerateDocument } from "./document.ts";

/**
 * The document `generate --json` prints for a run. `path` is `current.sql` as the document names it,
 * relative to the working directory. A reusable builder, since `generate --watch` embeds the same
 * document in each run's event (ADR-0032).
 */
export function generateDocument(result: GenerateResult, path: string): GenerateDocument {
  const { diff, leftover } = result;
  const edit =
    diff === undefined
      ? ({ handEdited: false } as const)
      : ({ handEdited: true, diff, ...(leftover === undefined ? {} : { leftover }) } as const);
  return {
    command: "generate",
    ok: true,
    file: { path, action: result.file, ...edit },
    hazards: result.sql === undefined ? [] : hazardsIn(result.sql),
    hints: result.hints,
    devDatabase: result.devDatabase,
  };
}
