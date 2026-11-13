import { ChainBrokenError, UnmodeledBlockerError } from "../../runtime/internal/index.ts";
import {
  CatchUpFailedError,
  DevDatabaseLockedError,
  HazardNotAcceptedError,
  NotDevDatabaseError,
  StrictLeftoverError,
} from "../generate/index.ts";
import type { CommandName, ErrorBody, FailureDocument } from "./document.ts";
import { generatedPart } from "./generate-document.ts";

/** A mistake in the arguments: the CLI exits 2 and, without `--json`, prints the usage. */
export class UsageError extends Error {}

/** `displayPath` writes a path the way the document names it, such as relative to the working directory. */
type Rule = (
  error: unknown,
  message: string,
  displayPath: (path: string) => string,
) => ErrorBody | undefined;

const RULES: readonly Rule[] = [
  (error, message) => (error instanceof UsageError ? { code: "usage", message } : undefined),
  (error, message) =>
    error instanceof DevDatabaseLockedError
      ? { code: "locked", message, lock: error.lock }
      : undefined,
  (error, message) =>
    error instanceof HazardNotAcceptedError
      ? { code: "hazard_not_accepted", message, kinds: error.kinds }
      : undefined,
  (error, message) =>
    error instanceof StrictLeftoverError
      ? { code: "leftover", message, leftover: error.leftover }
      : undefined,
  (error, message, displayPath) =>
    error instanceof CatchUpFailedError
      ? {
          code: "catch_up_failed",
          message,
          generated: generatedPart(error.generated, displayPath(error.generated.path)),
        }
      : undefined,
  (error, message) =>
    error instanceof UnmodeledBlockerError ? { code: "unmodeled_blocker", message } : undefined,
  (error, message) =>
    error instanceof ChainBrokenError ? { code: "chain_broken", message } : undefined,
  (error, message) =>
    error instanceof NotDevDatabaseError ? { code: "not_dev_database", message } : undefined,
];

/** Names a thrown value by the code an agent needs to pick a fix; anything else is `failed`. */
export function errorBody(error: unknown, displayPath: (path: string) => string): ErrorBody {
  const message = error instanceof Error ? error.message : String(error);
  for (const rule of RULES) {
    const body = rule(error, message, displayPath);
    if (body !== undefined) return body;
  }
  return { code: "failed", message };
}

export function failureDocument(
  command: CommandName | null,
  error: unknown,
  displayPath: (path: string) => string,
): FailureDocument {
  return { command, ok: false, error: errorBody(error, displayPath) };
}
