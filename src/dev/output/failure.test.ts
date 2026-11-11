import { describe, expect, it } from "vitest";
import { ChainBrokenError, UnmodeledBlockerError } from "../../runtime/internal/index.ts";
import {
  DevDatabaseLockedError,
  HazardNotAcceptedError,
  NotDevDatabaseError,
} from "../generate/index.ts";
import { errorBody, failureDocument, UsageError } from "./failure.ts";

describe("errorBody", () => {
  it.each([
    [new UsageError("name a command"), { code: "usage", message: "name a command" }],
    [
      new DevDatabaseLockedError("can't commit: locked"),
      { code: "locked", message: "can't commit: locked", lock: "dev" },
    ],
    [
      new HazardNotAcceptedError("has Hazards", ["data_loss", "rewrite"]),
      { code: "hazard_not_accepted", message: "has Hazards", kinds: ["data_loss", "rewrite"] },
    ],
    [new UnmodeledBlockerError("blocked"), { code: "unmodeled_blocker", message: "blocked" }],
    [new ChainBrokenError("forked chain"), { code: "chain_broken", message: "forked chain" }],
    [new NotDevDatabaseError("not dev"), { code: "not_dev_database", message: "not dev" }],
    [new Error("boom"), { code: "failed", message: "boom" }],
    [new TypeError("boom"), { code: "failed", message: "boom" }],
    ["thrown text", { code: "failed", message: "thrown text" }],
  ])("names %s", (error, body) => {
    expect(errorBody(error)).toStrictEqual(body);
  });
});

describe("failureDocument", () => {
  it("holds the command, ok false, and the error", () => {
    expect(failureDocument("commit", new Error("boom"))).toStrictEqual({
      command: "commit",
      ok: false,
      error: { code: "failed", message: "boom" },
    });
  });

  it("allows a null command", () => {
    expect(failureDocument(null, new UsageError("unknown command x"))).toStrictEqual({
      command: null,
      ok: false,
      error: { code: "usage", message: "unknown command x" },
    });
  });
});
