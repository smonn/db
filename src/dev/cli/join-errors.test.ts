import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./packed-package.test-helper.ts";
import { typeErrors } from "./type-errors.test-helper.ts";

const JOIN_FIXTURE = `import { createClient, defineDatabase, defineTable, from } from ${JSON.stringify(join(repo, "src/runtime/index.ts"))};

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      token: c.uuid().notNull(),
    })),
    posts: defineTable((c) => ({
      authorId: c.integer().notNull(),
      title: c.text().notNull(),
    })),
  },
});
declare const client: ReturnType<typeof createClient>;
const { users, posts } = db.public;
const joined = from(users).innerJoin(posts, (u, p) => p.authorId.eq(u.id));

void client.all(joined);
void joined.pick("id");
void joined.select((u) => ({ id: u.id })).innerJoin;
void from(users).select((u) => ({ id: u.id })).leftJoin;
void from(users).innerJoin(posts);
void from(users).innerJoin(posts, (u, p) => u.token.eq(p.title));
void from(users).leftJoin(posts, (u, p) => p.title.isNull());
void joined.where((u, p, x) => u.id.eq(1));
`;

describe("Join type errors", () => {
  it("name select on a joined builder, and print rows for each misuse of a join", async () => {
    const USERS = '{ id: number; token: string; }, { id: "number"; token: "uuid"; }';
    const POSTS = '{ authorId: number; title: string; }, { authorId: "number"; title: "text"; }';
    const JOINED = `[Refs<${USERS}>, Refs<${POSTS}>]`;
    const errors = await typeErrors(JOIN_FIXTURE);
    expect(errors).toEqual([
      `error TS2345: Argument of type 'JoinNeedsSelect<${JOINED}>' is not assignable to parameter of type 'Query<unknown>'.`,
      `error TS2339: Property 'pick' does not exist on type 'JoinNeedsSelect<${JOINED}>'.`,
      `error TS2339: Property 'innerJoin' does not exist on type 'JoinedQuery<${JOINED}, Selected<{ id: ColumnRef<number, "number">; }>>'.`,
      `error TS2339: Property 'leftJoin' does not exist on type 'SelectQuery<{ id: number; token: string; }, Selected<{ id: ColumnRef<number, "number">; }>, { id: "number"; token: "uuid"; }>'.`,
      `error TS2554: Expected 2 arguments, but got 1.`,
      `error TS2345: Argument of type 'ColumnRef<string, "text">' is not assignable to parameter of type 'string | ColumnOperand<"uuid">'.`,
      `error TS2339: Property 'isNull' does not exist on type 'ColumnRef<string, "text">'.`,
      `error TS2345: Argument of type '(u: any, p: any, x: any) => any' is not assignable to parameter of type '(refs_0: Refs<${USERS}>, refs_1: Refs<${POSTS}>) => Expr<boolean | null>'.`,
      `error TS7006: Parameter 'u' implicitly has an 'any' type.`,
      `error TS7006: Parameter 'p' implicitly has an 'any' type.`,
      `error TS7006: Parameter 'x' implicitly has an 'any' type.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/Table<|No overload/u);
  });
});
