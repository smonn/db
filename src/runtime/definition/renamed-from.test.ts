import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "./definition.ts";

const refuse = () =>
  defineTable(
    (c) => ({ id: c.text() }),
    // @ts-expect-error -- the old name is a string.
    () => ({ renamedFrom: 1 }),
  );

describe("renamedFrom", () => {
  it("records a column's and a table's old SQL name", () => {
    const t = defineTable(
      (c) => ({ id: c.uuid().primaryKey(), name: c.text().notNull().renamedFrom("nick") }),
      () => ({ renamedFrom: "people" }),
    );
    expect(t.columns.name.state).toMatchObject({ renamedFrom: "nick", notNull: true });
    expect(t.columns.id.state.renamedFrom).toBeUndefined();
    expect(t.renamedFrom).toBe("people");
  });

  it("stays through the other column calls", () => {
    const t = defineTable((c) => ({
      id: c.integer().renamedFrom("old_id").identity().primaryKey(),
      email: c.text().renamedFrom("mail").unique(),
    }));
    expect(t.columns.id.state.renamedFrom).toBe("old_id");
    expect(t.columns.email.state.renamedFrom).toBe("mail");
  });

  it("carries a table's marker through defineDatabase", () => {
    const people = defineTable(
      (c) => ({ id: c.text() }),
      () => ({ renamedFrom: "users" }),
    );
    expect(defineDatabase({ public: { people } }).public.people.renamedFrom).toBe("users");
  });

  it("refuses a table marker that isn't a string", () => {
    expect(refuse).toThrow("renamedFrom takes the old SQL name as a string");
  });
});
