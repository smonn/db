import { describe, expect, it } from "vitest";
import { explainShadowError } from "./shadow-errors.ts";

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The message of the error `explainShadowError` returns, or an empty string for anything else. */
function explained(error: unknown, options?: Parameters<typeof explainShadowError>[1]): string {
  const result = explainShadowError(error, options);
  return result instanceof Error ? result.message : "";
}

describe("explainShadowError for 25001", () => {
  const blocked = postgresError(
    "25001",
    "CREATE INDEX CONCURRENTLY cannot run inside a transaction block",
  );

  it("names the no-transaction header as the fix, and keeps the code and the cause", () => {
    expect(explained(blocked)).toBe(
      "CREATE INDEX CONCURRENTLY cannot run inside a transaction block\nIf the statement can't run in a transaction, add `--! no-transaction` as the first line of the Current migration (ADR-0020).",
    );
    expect(explainShadowError(blocked)).toMatchObject({ code: "25001" });
    expect(explainShadowError(blocked)).toHaveProperty("cause", blocked);
  });

  it("leaves the error alone once the file carries the header", () => {
    expect(explainShadowError(blocked, { noTransaction: true })).toBe(blocked);
  });
});

describe("explainShadowError for 42804", () => {
  const uncastable = postgresError(
    "42804",
    'column "id" cannot be cast automatically to type integer',
  );

  it("offers a USING clause or a default change for a generated migration", () => {
    expect(explained(uncastable)).toMatch(
      /^column "id" cannot be cast automatically to type integer\nGenerate writes a plain ALTER COLUMN \.\.\. TYPE with no USING and leaves defaults alone\. Hand edit the Current migration to add a USING clause or change the column's default\.$/u,
    );
  });

  it("words the fix for a hand edit", () => {
    expect(explained(uncastable, { handEdited: true })).toMatch(
      /\nAdd a USING clause to the ALTER COLUMN \.\.\. TYPE, or change the column's default, in the Current migration\.$/u,
    );
  });

  it("keeps the Postgres error as the cause", () => {
    expect(explainShadowError(uncastable)).toHaveProperty("cause", uncastable);
  });
});

describe("explainShadowError for a domain array", () => {
  const message = 'cannot alter type "tags" because column "t"."a" uses it';
  const blocked = postgresError("0A000", message);

  it("words the fix for generated SQL and for a hand edit", () => {
    expect(explained(blocked)).toMatch(/\nGenerate adds a domain check or sets a domain NOT NULL/u);
    expect(explained(blocked, { handEdited: true })).toMatch(
      /\nPostgres refuses ALTER DOMAIN \.\.\. ADD CONSTRAINT and SET NOT NULL while a column holds an array of the domain\. Retype that column/u,
    );
  });

  it("gives that message under another code the fix for the code", () => {
    expect(explained(postgresError("42804", message))).toMatch(
      /\nGenerate writes a plain ALTER COLUMN/u,
    );
  });

  it("leaves other 0A000 messages unexplained", () => {
    const unrelated = postgresError("0A000", "feature not supported");

    expect(explainShadowError(unrelated)).toBe(unrelated);
  });
});

describe("explainShadowError for a code that isn't a known string", () => {
  it.each([["toString"], ["constructor"], ["99999"]])("leaves code %s alone", (code) => {
    const unknown = postgresError(code, "boom");

    expect(explainShadowError(unknown)).toBe(unknown);
  });

  it("leaves a numeric code alone, though its digits name a known one", () => {
    const numeric = Object.assign(new Error("boom"), { code: 42_804 });

    expect(explainShadowError(numeric)).toBe(numeric);
  });
});

describe("explainShadowError for something that isn't an Error", () => {
  it.each([[null], [undefined], ["text"], [{ code: "42804" }]])("returns %j as it is", (value) => {
    expect(explainShadowError(value)).toBe(value);
  });
});

describe("explainShadowError for a blocker", () => {
  const blocker = postgresError("2BP01", "cannot drop column c because other objects depend on it");

  it("words the hint for a hand edit apart from generated SQL", () => {
    expect(explained(blocker, { handEdited: true })).toMatch(
      /\nAnother object depends on what it changes\. Hand edit/u,
    );
    expect(explained(blocker)).toMatch(/\nGenerate never uses CASCADE/u);
  });
});
