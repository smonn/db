import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import type { ActionKind } from "./actions.ts";
import { diff } from "./diff.ts";
import { SCANS, type ScanTable } from "./scans.ts";

/** A kind the diff doesn't have yet, such as a view drop. */
type Future = ActionKind | "drop view";

const text = { type: "text", notNull: false };
const code = { base: "text", default: null, defaultVolatile: false, notNull: false };

function catalog(build: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  build(builder);
  return builder.build();
}

describe("the scan of each action kind", () => {
  it("fails to compile until a new kind names its walk", () => {
    const complete: ScanTable<Future> = { ...SCANS, "drop view": "drop" };

    // @ts-expect-error -- no walk for the new kind.
    const none: ScanTable<Future> = { ...SCANS };

    // @ts-expect-error -- a walk the scan doesn't have.
    const unlisted: ScanTable<Future> = { ...SCANS, "drop view": "cascade" };

    expect([complete, none, unlisted]).toHaveLength(3);
  });

  it("addresses each dropped or retyped object as pg_get_object_address takes it", () => {
    const from = catalog((b) => {
      b.table("app", "users.x");
      b.column("app", "users.x", "id", text);
      b.column("app", "users.x", "email", text);
      b.columnDefault("app", "users.x", "email", { expression: "'x'::text", volatile: false });
      b.column("app", "users.x", "upper", text);
      b.columnGenerated("app", "users.x", "upper", {
        expression: "upper(email)",
        storage: "stored",
      });
      b.unique("app", "users.x", "users_email_key", {
        columns: ["email"],
        nullsNotDistinct: false,
      });
      b.index("app", "users.x", "users_id_idx", {
        unique: false,
        method: "btree",
        keys: [{ column: "id", descending: false, nullsFirst: false }],
        include: [],
        where: undefined,
        nullsNotDistinct: false,
      });
      b.domain("app", "code", code);
      b.domainCheck("app", "code", "short", { expression: "length(VALUE) < 9" });
      b.table("app", "gone");
    });
    const to = catalog((b) => {
      b.table("app", "users.x");
      b.column("app", "users.x", "id", { type: "integer", notNull: false });
      b.column("app", "users.x", "email", { type: "text", notNull: true });
      b.column("app", "users.x", "upper", text);
      b.domain("app", "code", code);
    });

    expect(diff(from, to).scans).toStrictEqual([
      { walk: "drop", object: { type: "index", names: ["app", "users_id_idx"], args: [] } },
      {
        walk: "drop",
        object: {
          type: "table constraint",
          names: ["app", "users.x", "users_email_key"],
          args: [],
        },
      },
      { walk: "drop", object: { type: "table", names: ["app", "gone"], args: [] } },
      {
        walk: "drop",
        object: { type: "domain constraint", names: [`"app"."code"`], args: ["short"] },
      },
      {
        walk: "remove",
        object: { type: "default value", names: ["app", "users.x", "upper"], args: [] },
      },
      {
        walk: "retype",
        object: { type: "table column", names: ["app", "users.x", "id"], args: [] },
      },
    ]);
  });
});
