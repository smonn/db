import { ChainBrokenError, UnmodeledBlockerError } from "../../runtime/internal/index.ts";
import {
  DevDatabaseLockedError,
  HazardNotAcceptedError,
  NotDevDatabaseError,
  StrictLeftoverError,
} from "../generate/index.ts";
import type { CommandName, ErrorBody, FailureDocument } from "./document.ts";

/** A mistake in the arguments: the CLI exits 2 and, without `--json`, prints the usage. */
export class UsageError extends Error {}

type Rule = (error: unknown, message: string) => ErrorBody | undefined;

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
  (error, message) =>
    error instanceof UnmodeledBlockerError ? { code: "unmodeled_blocker", message } : undefined,
  (error, message) =>
    error instanceof ChainBrokenError ? { code: "chain_broken", message } : undefined,
  (error, message) =>
    error instanceof NotDevDatabaseError ? { code: "not_dev_database", message } : undefined,
];

/** Names a thrown value by the code an agent needs to pick a fix; anything else is `failed`. */
export function errorBody(error: unknown): ErrorBody {
  const message = error instanceof Error ? error.message : String(error);
  for (const rule of RULES) {
    const body = rule(error, message);
    if (body !== undefined) return body;
  }
  return { code: "failed", message };
}

export function failureDocument(command: CommandName | null, error: unknown): FailureDocument {
  return { command, ok: false, error: errorBody(error) };
}
