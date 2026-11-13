import type { HazardKind } from "../diff/index.ts";

export type CommandName = "generate" | "commit" | "reset" | "migrate" | "verify" | "rebase";

/** What each command adds to `{ command, ok: true }`. */
type Results = {
  generate: {
    readonly file: {
      /** `current.sql`, relative to the working directory, as plain mode prints it. */
      readonly path: string;
      /**
       * What generate did to it: `written` or `removed` it; `kept` a file that already held what it
       * would write, or a hand-edited one; `absent` when there was no diff and no file to remove.
       */
      readonly action: "written" | "removed" | "kept" | "absent";
    } & (
      | { readonly handEdited: false }
      | {
          /** The file was hand-edited, so generate replayed it as written (ADR-0003). */
          readonly handEdited: true;
          /** The lines that differ from what generate would write, `-` for the file and `+` for the generation. Empty when they match. */
          readonly diff: string;
          /** How running the edit leaves the Shadow unlike the Definition (ADR-0013). A warning here; `strict: true` fails with the `leftover` error instead. */
          readonly leftover?: string;
        }
    );
    /** Each Hazard in the file's body, as `commit` would gate it, even when the run changed nothing. */
    readonly hazards: readonly { readonly kind: string; readonly statement: string }[];
    /** Renames the Definition could declare, one line each (ADR-0024), even when the run changed nothing. */
    readonly hints: readonly string[];
    /** What generate did to the Dev database (ADR-0030). */
    readonly devDatabase:
      | { readonly kind: "none" }
      | { readonly kind: "reset" }
      | {
          readonly kind: "replayed";
          /** The Committed files it applied, in order, then `current.sql` when it applied that too. */
          readonly files: readonly string[];
          /** The Hazards in the Committed files it applied. */
          readonly hazards: readonly {
            readonly file: string;
            readonly kind: string;
            readonly statement: string;
          }[];
        }
      | {
          readonly kind: "diffed";
          /** The files the tracking rows now record whose statements never ran in the Dev database. */
          readonly skipped: readonly string[];
          /** The Hazards in the changes it made to the Dev database. */
          readonly hazards: readonly { readonly kind: HazardKind; readonly statement: string }[];
        };
  };
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

type Document<Name extends keyof Results> = {
  readonly command: Name;
  readonly ok: true;
} & Results[Name];

export type GenerateDocument = Document<"generate">;
export type CommitDocument = Document<"commit">;
export type ResetDocument = Document<"reset">;
export type MigrateDocument = Document<"migrate">;
export type VerifyDocument = Document<"verify">;
export type RebaseDocument = Document<"rebase">;

/** The document a command prints on success: one per command, told apart by `command`. */
export type SuccessDocument = { [Name in keyof Results]: Document<Name> }[keyof Results];

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
  // No command emits catch_up_failed yet; the catch-up that raises it does.
  | { readonly code: "catch_up_failed"; readonly message: string }
  | {
      readonly code: "leftover";
      readonly message: string;
      /** The difference a hand edit leaves from the Definition, which `strict: true` refuses. */
      readonly leftover: string;
    }
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
