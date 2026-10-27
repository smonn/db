import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { relabeled } from "./enums.test-helper.ts";
import { refuseTypeChanges } from "./type-refusals.ts";

const DOMAIN = { base: "text", default: null, defaultVolatile: false, notNull: false };

/** `public.mood` (a, b, c), and a table `users` with a column of it, then whatever `more` adds. */
function world(more: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.enumType("public", "mood", { labels: ["a", "b", "c"] });
  builder.table("public", "users");
  builder.column("public", "users", "mood", { type: "public.mood", notNull: false });
  more(builder);
  return builder.build();
}

/** What `expect(...).toThrow` calls, so a void call isn't an arrow function's result. */
function refusing(from: Catalog, to: Catalog): () => void {
  return () => {
    refuseTypeChanges({ from, to });
  };
}

function swap(more: (builder: CatalogBuilder) => void): [Catalog, Catalog] {
  const from = world(more);
  return [from, relabeled(from, ["c", "b", "a"])];
}

function withTable(): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "x");
  return builder.build();
}

function withDomain(): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.domain("public", "x", DOMAIN);
  return builder.build();
}

describe("refuseTypeChanges beside an enum swap", () => {
  it("leaves a virtual generated column of the enum, which computes on read", () => {
    const [from, to] = swap((builder) => {
      builder.column("public", "users", "feeling", { type: "public.mood", notNull: false });
      builder.columnGenerated("public", "users", "feeling", {
        expression: "mood",
        storage: "virtual",
      });
    });

    expect(refusing(from, to)).not.toThrow();
  });

  it("refuses a stored generated column of the enum", () => {
    const [from, to] = swap((builder) => {
      builder.column("public", "users", "feeling", { type: "public.mood", notNull: false });
      builder.columnGenerated("public", "users", "feeling", {
        expression: "mood",
        storage: "stored",
      });
    });

    expect(refusing(from, to)).toThrow(/while a stored generated column has its type/u);
  });

  it("leaves a domain over another type that stays", () => {
    const [from, to] = swap((builder) => {
      builder.domain("public", "code", DOMAIN);
    });

    expect(refusing(from, to)).not.toThrow();
  });

  it("refuses a domain over the enum that stays", () => {
    const [from, to] = swap((builder) => {
      builder.domain("public", "code", { ...DOMAIN, base: "public.mood" });
    });

    expect(refusing(from, to)).toThrow(/while a domain depends on it: "public"\."code"/u);
  });
});

describe("refuseTypeChanges for a name that changes kind", () => {
  it("leaves a table that a domain replaces, and a domain that a table replaces", () => {
    expect(refusing(withTable(), withDomain())).not.toThrow();
    expect(refusing(withDomain(), withTable())).not.toThrow();
  });
});
