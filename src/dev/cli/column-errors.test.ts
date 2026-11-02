import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const FIXTURE = `import { defineTable } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

defineTable((c) => ({
  id: c.integer().default("1").identity(),
  tags: c.text().notNull().array(),
}));
`;

describe("Column type errors", () => {
  it("name each flag", async () => {
    expect(await typeErrors(FIXTURE)).toEqual([
      "error TS2339: Property 'identity' does not exist on type 'Column<number, { notNull: false; int: true; sqlClass: \"number\"; generated: true; identityMode: undefined; primaryKey: false; key: false; codec: false; references: false; fresh: false; }>'.",
      "error TS2339: Property 'array' does not exist on type 'Column<string, { notNull: true; int: false; sqlClass: \"text\"; generated: false; identityMode: undefined; primaryKey: false; key: false; codec: false; references: false; fresh: false; }>'.",
    ]);
  });
});
