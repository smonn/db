import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const FIXTURE = `import { createClient, defineDatabase, defineTable, from, insert, type SelectQuery } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
    })),
  },
});
declare const client: ReturnType<typeof createClient>;

void client.run(insert(db.public.users));
export const wrong: SelectQuery<{ id: string }> = from(db.public.users);
void from(db.public.users).where((u) => u.nope.isNull());
`;

const ROW = "{ id: number; email: string; name: string | null; }";
const NEW_ROW = "{ email: string; } & { id?: number; name?: string | null; }";

describe("Builder type errors", () => {
  it("print rows, and name the call an unfinished insert needs", async () => {
    expect(await typeErrors(FIXTURE)).toEqual([
      `error TS2741: Property 'toSql' is missing in type 'InsertNeedsValues<${ROW}, ${NEW_ROW}>' but required in type 'Statement'.`,
      `error TS2322: Type 'SelectQuery<${ROW}, ${ROW}>' is not assignable to type 'SelectQuery<{ id: string; }>'.`,
      `error TS2339: Property 'nope' does not exist on type 'Refs<${ROW}>'.`,
    ]);
  });
});
