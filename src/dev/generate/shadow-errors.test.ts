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
    expect(explainShadowError(blocked)).toMatchObject({ code: "25001", cause: blocked });
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
