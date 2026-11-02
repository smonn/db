import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable, type Row } from "../definition/index.ts";
import type { Expr } from "./expr.ts";
import { from } from "./from.ts";
import { and, not, or, renderOutput, type Predicate, type Refs } from "./refs.ts";
import type { Query } from "./statement.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
  },
});

describe("from", () => {
  it("selects every column of the table without select", () => {
    expect(from(db.public.users).toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users"',
      params: [],
    });
  });

  it("types the rows as the table's Row without select", () => {
    expectTypeOf(from(db.public.users)).toExtend<Query<{ id: string; email: string | null }>>();
  });
});

describe("select", () => {
  it("names each output column by its key", () => {
    const query = from(db.public.users).select((u) => ({ id: u.id, mail: u.email }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" as "mail" from "public"."users"',
      params: [],
    });
  });

  it("types each output column by its key, keeping nullability", () => {
    const query = from(db.public.users).select((u) => ({ mail: u.email, key: u.id }));
    expectTypeOf(query).toExtend<Query<{ mail: string | null; key: string }>>();
    expectTypeOf(query).not.toExtend<Query<{ mail: string; key: string }>>();
  });

  it("replaces the previous select", () => {
    const query = from(db.public.users)
      .select((u) => ({ id: u.id }))
      .select((u) => ({ email: u.email }));
    expect(query.toSql().text).toBe('select "email" from "public"."users"');
  });

  it("refuses a selection with no columns", () => {
    expect(() => from(db.public.users).select(() => ({}))).toThrow(
      "select needs at least one column",
    );
  });

  it("quotes names that need it", () => {
    const odd = defineDatabase({
      'my"schema': { "Odd Table": defineTable((c) => ({ "a b": c.text() })) },
    });
    expect(from(odd['my"schema']["Odd Table"]).toSql().text).toBe(
      'select "a b" from "my""schema"."Odd Table"',
    );
  });

  it("hands select only the table's columns", () => {
    expectTypeOf<keyof Refs<Row<typeof db.public.users>>>().toEqualTypeOf<"id" | "email">();
  });
});

describe("pick", () => {
  it("selects each named column under its own key", () => {
    expect(from(db.public.users).pick("id", "email").toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users"',
      params: [],
    });
  });

  it("selects in the order named, not the table's", () => {
    expect(from(db.public.users).pick("email", "id").toSql().text).toBe(
      'select "email", "id" from "public"."users"',
    );
  });

  it("types each named column by its key, keeping nullability", () => {
    const query = from(db.public.users).pick("email", "id");
    expectTypeOf(query).toExtend<Query<{ email: string | null; id: string }>>();
    expectTypeOf(query).not.toExtend<Query<{ email: string; id: string }>>();
    expectTypeOf(query).not.toExtend<Query<{ email: string | null; id: string; extra: number }>>();
  });

  it("replaces an earlier select or pick, and is replaced by a later one", () => {
    const users = from(db.public.users);
    expect(
      users
        .select((u) => ({ mail: u.email }))
        .pick("id")
        .toSql().text,
    ).toBe('select "id" from "public"."users"');
    expect(
      users
        .pick("id")
        .select((u) => ({ mail: u.email }))
        .toSql().text,
    ).toBe('select "email" as "mail" from "public"."users"');
    expect(users.pick("id").pick("email").toSql().text).toBe(
      'select "email" from "public"."users"',
    );
  });

  it("selects a column once however often it is named", () => {
    const query = from(db.public.users).pick("id", "id", "email");
    expect(query.toSql().text).toBe('select "id", "email" from "public"."users"');
  });

  it("refuses a name that is no column, for a caller the types don't stop", () => {
    const users = from(db.public.users);
    // @ts-expect-error the name is no column
    expect(() => users.pick("nope")).toThrow('pick: "nope" is not a column of "public"."users"');
    // @ts-expect-error toString is inherited, not a column
    expect(() => users.pick("toString")).toThrow('pick: "toString" is not a column');
  });

  it("refuses an empty list, for a caller the types don't stop", () => {
    const users: { pick(...names: string[]): unknown } = from(db.public.users);
    expect(() => users.pick()).toThrow("pick needs at least one column");
  });

  it("follows the SQL names defineDatabase mapped", () => {
    const odd = defineDatabase({
      public: {
        "Odd Table": defineTable((c) => ({ rank: c.integer().name("Odd Rank"), tags: c.text() })),
      },
    });
    expect(from(odd.public["Odd Table"]).pick("rank", "tags").toSql().text).toBe(
      'select "Odd Rank" as "rank", "tags" from "public"."Odd Table"',
    );
  });

  it("combines with where, orderBy, limit, and offset, whichever call comes first", () => {
    const query = from(db.public.users)
      .offset(4)
      .limit(2)
      .orderBy((u) => u.email.desc())
      .where((u) => u.id.gt("a"))
      .pick("id");
    expect(query.toSql()).toStrictEqual({
      text: 'select "id" from "public"."users" where "id" > $1 order by "users"."email" desc limit $2 offset $3',
      params: ["a", 2, 4],
    });
  });

  it("keeps the earlier clauses when it comes first", () => {
    const query = from(db.public.users)
      .pick("id")
      .where((u) => u.email.isNull())
      .orderBy((u) => u.id)
      .limit(1);
    expect(query.toSql().text).toBe(
      'select "id" from "public"."users" where "email" is null order by "users"."id" limit $1',
    );
  });

  it("hands where and orderBy the whole row, not only the picked columns", () => {
    const query = from(db.public.users).pick("id");
    expectTypeOf<Parameters<Parameters<typeof query.where>[0]>[0]>().toEqualTypeOf<
      Refs<{ id: string; email: string | null }, { id: "text"; email: "text" }>
    >();
  });
});

describe("where", () => {
  const users = from(db.public.users);

  it("renders each comparison with its value as a param", () => {
    const cases = [
      [users.where((u) => u.id.eq("a")), '"id" = $1', ["a"]],
      [users.where((u) => u.id.ne("a")), '"id" <> $1', ["a"]],
      [users.where((u) => u.id.gt("a")), '"id" > $1', ["a"]],
      [users.where((u) => u.id.gte("a")), '"id" >= $1', ["a"]],
      [users.where((u) => u.id.lt("a")), '"id" < $1', ["a"]],
      [users.where((u) => u.id.lte("a")), '"id" <= $1', ["a"]],
      [users.where((u) => u.email.isNull()), '"email" is null', []],
      [users.where((u) => u.email.isNotNull()), '"email" is not null', []],
    ] as const;
    for (const [query, predicate, params] of cases) {
      expect(query.toSql()).toStrictEqual({
        text: `select "id", "email" from "public"."users" where ${predicate}`,
        params,
      });
    }
  });

  it("joins terms with and, parenthesised", () => {
    const query = users.where((u) => and(u.id.gt("a"), u.id.lt("z"), u.email.isNull()));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where ("id" > $1 and "id" < $2 and "email" is null)',
      params: ["a", "z"],
    });
  });

  it("joins terms with or, parenthesised", () => {
    const query = users.where((u) => or(u.id.eq("a"), u.id.eq("b")));
    expect(query.toSql().text).toBe(
      'select "id", "email" from "public"."users" where ("id" = $1 or "id" = $2)',
    );
  });

  it("negates with not", () => {
    const query = users.where((u) => not(u.id.eq("a")));
    expect(query.toSql().text).toBe(
      'select "id", "email" from "public"."users" where not ("id" = $1)',
    );
  });

  it("nests, numbering params in order", () => {
    const query = users.where((u) =>
      and(or(u.id.eq("a"), u.id.eq("b")), not(and(u.email.isNull(), u.id.ne("c")))),
    );
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where (("id" = $1 or "id" = $2) and not (("email" is null and "id" <> $3)))',
      params: ["a", "b", "c"],
    });
  });

  it("keeps the select, whichever call comes first", () => {
    const selectFirst = users.select((u) => ({ mail: u.email })).where((u) => u.id.eq("a"));
    const whereFirst = users.where((u) => u.id.eq("a")).select((u) => ({ mail: u.email }));
    const expected = {
      text: 'select "email" as "mail" from "public"."users" where "id" = $1',
      params: ["a"],
    };
    expect(selectFirst.toSql()).toStrictEqual(expected);
    expect(whereFirst.toSql()).toStrictEqual(expected);
  });

  it("combines a second where with the first using and", () => {
    const query = users.where((u) => u.id.gt("a")).where((u) => or(u.id.eq("b"), u.email.isNull()));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users" where ("id" > $1 and ("id" = $2 or "email" is null))',
      params: ["a", "b"],
    });
  });

  it("takes one or more predicates in and and or, and exactly one in not", () => {
    type Term = Expr<boolean | null>;
    expectTypeOf(and).parameters.toEqualTypeOf<[first: Term, ...rest: Term[]]>();
    expectTypeOf(or).parameters.toEqualTypeOf<[first: Term, ...rest: Term[]]>();
    expectTypeOf(not).parameters.toEqualTypeOf<[term: Term]>();
    expectTypeOf(and).returns.toEqualTypeOf<Predicate>();
  });

  it("offers isNull and isNotNull only on nullable columns", () => {
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return -- The calls are the type errors under test. */
    const notNull = users.where((u) => {
      // @ts-expect-error -- id is NOT NULL.
      return u.id.isNull();
    });
    const notNotNull = users.where((u) => {
      // @ts-expect-error -- id is NOT NULL.
      return u.id.isNotNull();
    });
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return */
    expect(notNull.toSql().text).toContain("is null");
    expect(notNotNull.toSql().text).toContain("is not null");
  });

  it("does not change the row type", () => {
    expectTypeOf(users.where((u) => u.id.eq("a"))).toExtend<
      Query<{ id: string; email: string | null }>
    >();
  });

  it("compares a column only with its own value type, never null", () => {
    type UserRefs = Refs<Row<typeof db.public.users>>;
    expectTypeOf<Parameters<UserRefs["id"]["eq"]>>().toEqualTypeOf<[value: string]>();
    expectTypeOf<Parameters<UserRefs["email"]["eq"]>>().toEqualTypeOf<[value: string]>();
  });
});

describe("renderOutput", () => {
  it("names an output that is no column of the table as its own identifier", () => {
    expect(renderOutput(db.public.users, ["alias", "missing"]).toSql()).toStrictEqual({
      text: '"missing" as "alias"',
      params: [],
    });
  });
});

describe("from on an unregistered table", () => {
  it("throws when called, naming defineDatabase", () => {
    const bare: unknown = defineTable((c) => ({ id: c.text().notNull() }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
    const call = () => from(bare as typeof db.public.users);
    expect(call).toThrow(Error);
    expect(call).toThrow(/lacks SQL names.*defineDatabase/u);
  });
});
