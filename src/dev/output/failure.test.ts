import { describe, expect, it } from "vitest";
import { ChainBrokenError, UnmodeledBlockerError } from "../../runtime/internal/index.ts";
import {
  CatchUpFailedError,
  DevDatabaseLockedError,
  HazardNotAcceptedError,
  NotDevDatabaseError,
  StrictLeftoverError,
  WatcherLockedError,
} from "../generate/index.ts";
import { errorBody, failureDocument, UsageError } from "./failure.ts";

/** Names a path relative to a working directory of `/work`. */
const displayed = (path: string): string => path.replace("/work/", "");

describe("errorBody", () => {
  it.each([
    [new UsageError("name a command"), { code: "usage", message: "name a command" }],
    [
      new DevDatabaseLockedError("can't commit: locked"),
      { code: "locked", message: "can't commit: locked", lock: "dev" },
    ],
    [
      new WatcherLockedError("can't watch: locked"),
      { code: "locked", message: "can't watch: locked", lock: "watch" },
    ],
    [
      new HazardNotAcceptedError("has Hazards", ["data_loss", "rewrite"]),
      { code: "hazard_not_accepted", message: "has Hazards", kinds: ["data_loss", "rewrite"] },
    ],
    [
      new StrictLeftoverError("refused", "table is missing"),
      { code: "leftover", message: "refused", leftover: "table is missing" },
    ],
    [
      new CatchUpFailedError(new Error("boom"), {
        path: "/work/db/current.sql",
        sql: "select 1;\n",
        file: "written",
        hazards: [],
        hints: ["a hint"],
      }),
      {
        code: "catch_up_failed",
        message: "boom",
        generated: {
          file: { path: "db/current.sql", action: "written", handEdited: false },
          hazards: [],
          hints: ["a hint"],
        },
      },
    ],
    [new UnmodeledBlockerError("blocked"), { code: "unmodeled_blocker", message: "blocked" }],
    [new ChainBrokenError("forked chain"), { code: "chain_broken", message: "forked chain" }],
    [new NotDevDatabaseError("not dev"), { code: "not_dev_database", message: "not dev" }],
    [new Error("boom"), { code: "failed", message: "boom" }],
    [new TypeError("boom"), { code: "failed", message: "boom" }],
    ["thrown text", { code: "failed", message: "thrown text" }],
  ])("names %s", (error, body) => {
    expect(errorBody(error, displayed)).toStrictEqual(body);
  });
});

describe("failureDocument", () => {
  it("holds the command, ok false, and the error", () => {
    expect(failureDocument("commit", new Error("boom"), displayed)).toStrictEqual({
      command: "commit",
      ok: false,
      error: { code: "failed", message: "boom" },
    });
  });

  it("allows a null command", () => {
    expect(failureDocument(null, new UsageError("unknown command x"), displayed)).toStrictEqual({
      command: null,
      ok: false,
      error: { code: "usage", message: "unknown command x" },
    });
  });
});
