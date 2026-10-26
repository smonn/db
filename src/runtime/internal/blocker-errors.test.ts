import { describe, expect, it } from "vitest";
import { explainBlockerError, type BlockerSource } from "./blocker-errors.ts";

function postgresError(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error(message), { code, detail });
}

function messageOf(value: unknown): string {
  if (!(value instanceof Error)) throw new TypeError("expected an Error");
  return value.message;
}

const generated: BlockerSource = { kind: "generated" };

describe("explainBlockerError", () => {
  it("lists the blockers and names the hand edit for generated SQL", () => {
    const error = postgresError(
      "2BP01",
      "cannot drop table t",
      "view v depends on table t\nrule r depends on table t",
    );

    const mapped = explainBlockerError(error, { source: generated });

    expect(messageOf(mapped)).toBe(
      "cannot drop table t:\n  view v depends on table t\n  rule r depends on table t\nGenerate never uses CASCADE or alters an Unmodeled object, so one blocks it. Hand edit the Current migration to drop or change that object.",
    );
    expect(mapped).toHaveProperty("cause", error);
  });

  it("words the hint for a hand edit", () => {
    const mapped = explainBlockerError(postgresError("2BP01", "cannot drop table t", "x"), {
      source: { kind: "hand-edited" },
    });

    expect(messageOf(mapped)).toMatch(/\nAn Unmodeled object blocks it\. Hand edit the Current/u);
  });

  it("names the file and the new migration for a Committed file", () => {
    const mapped = explainBlockerError(
      postgresError("2BP01", "cannot drop table t", "view v depends on table t"),
      { source: { kind: "committed", filename: "000003-x.sql" } },
    );

    expect(messageOf(mapped)).toMatch(
      /\n000003-x\.sql rolled back\. .*fix it in a new migration\.$/u,
    );
  });

  it.each([
    "cannot alter type of a column used by a view or rule",
    "cannot alter type of a column used by a generated column",
  ])("maps the 0A000 variant %s", (message) => {
    const mapped = explainBlockerError(postgresError("0A000", message), { source: generated });

    expect(messageOf(mapped)).toMatch(/\nGenerate never uses CASCADE/u);
  });

  it.each([
    postgresError("0A000", "cannot alter type of a column used in a policy definition"),
    postgresError("0A000", "cannot alter type of a column used in a trigger definition"),
    postgresError("0A000", "something else is unsupported"),
    postgresError("42804", "column cannot be cast"),
    new Error("plain"),
    "not an error",
  ])("passes %s through unchanged", (error) => {
    expect(explainBlockerError(error, { source: generated })).toBe(error);
  });
});
