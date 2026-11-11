import type { HazardKind } from "../diff/index.ts";

export type CommandName = "generate" | "commit" | "reset" | "migrate" | "verify" | "rebase";

/** What each command adds to `{ command, ok: true }`. `generate` has no entry until its document lands. */
type Results = {
  commit: {
    /** The Committed migration it wrote. `path` is relative to the working directory, as plain mode prints it. */
    readonly file: { readonly path: string };
  };
  reset: {
    /** How many Committed migrations it replayed. */
    readonly committed: number;
    /** Whether it replayed `current.sql` after them. */
    readonly current: boolean;
  };
  migrate: {
    /** The filenames it applied, in order; empty when nothing was pending. */
    readonly applied: readonly string[];
  };
  verify: {
    /** The filenames whose chain it checked, in sequence order. */
    readonly verified: readonly string[];
  };
  rebase: {
    readonly onto: string;
    /** Each file it rewrote, by old and new filename, in chain order; empty when nothing moved. */
    readonly moved: readonly { readonly from: string; readonly to: string }[];
  };
};

/** The document a command prints on success: one per command, told apart by `command`. */
export type SuccessDocument = {
  [Name in keyof Results]: { readonly command: Name; readonly ok: true } & Results[Name];
}[keyof Results];

/** Why a command failed. `code` tells an agent which fix to pick; `message` is the plain text it prints without `--json`. */
export type ErrorBody =
  | { readonly code: "usage"; readonly message: string }
  | {
      readonly code: "locked";
      readonly message: string;
      /** Which advisory lock another run holds: the lock `generate`, `commit`, and `reset` share on the Dev database. */
      readonly lock: "dev";
    }
  | {
      readonly code: "hazard_not_accepted";
      readonly message: string;
      /** The Hazard kinds in `current.sql` that `--accept` doesn't name. */
      readonly kinds: readonly HazardKind[];
    }
  // No command emits catch_up_failed or leftover yet; the features that raise them do.
  | { readonly code: "catch_up_failed"; readonly message: string }
  | { readonly code: "leftover"; readonly message: string }
  | { readonly code: "unmodeled_blocker"; readonly message: string }
  | { readonly code: "chain_broken"; readonly message: string }
  | { readonly code: "not_dev_database"; readonly message: string }
  | { readonly code: "failed"; readonly message: string };

export type ErrorCode = ErrorBody["code"];

/**
 * The document a command prints on failure. `command` is null when the arguments name no command
 * the CLI knows, such as a misspelled one.
 */
export type FailureDocument = {
  readonly command: CommandName | null;
  readonly ok: false;
  readonly error: ErrorBody;
};

export type JsonDocument = SuccessDocument | FailureDocument;
