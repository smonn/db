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

function kindOf(kind: "enum" | "domain"): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  if (kind === "enum") builder.enumType("public", "x", { labels: ["a"] });
  else builder.domain("public", "x", DOMAIN);
  return builder.build();
}

function domainOver(base: string): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.domain("public", "x", { ...DOMAIN, base });
  return builder.build();
}

describe("refuseTypeChanges against the Dev database", () => {
  it.each<[string, () => [Catalog, Catalog]]>([
    ["a name that changes kind", () => [kindOf("enum"), kindOf("domain")]],
    ["a domain's new base type", () => [domainOver("text"), domainOver("integer")]],
    [
      "a domain over a swapped enum",
      () =>
        swap((builder) => {
          builder.domain("public", "code", { ...DOMAIN, base: "public.mood" });
        }),
    ],
    [
      "a stored generated column of a swapped enum",
      () =>
        swap((builder) => {
          builder.column("public", "users", "feeling", { type: "public.mood", notNull: false });
          builder.columnGenerated("public", "users", "feeling", {
            expression: "mood",
            storage: "stored",
          });
        }),
    ],
  ])(
    "ends %s with its reason, since generate wrote the files and no migration is left to write",
    (_name, build) => {
      const [from, to] = build();
      const refuse = (): void => {
        refuseTypeChanges({ from, to }, "dev");
      };

      expect(refuse).toThrow(/^Generate can't .*[^.]$/su);
      expect(refuse).not.toThrow(/wrote no migration/u);
    },
  );
});

describe("refuseTypeChanges against the Shadow", () => {
  it("names the migration to write by hand for a domain's new base type", () => {
    expect(() => {
      refuseTypeChanges({ from: domainOver("text"), to: domainOver("integer") });
    }).toThrow(
      `Generate can't change the base type of the domain "public"."x" from text to integer: Postgres has no ALTER DOMAIN for it. Generate wrote no migration: write this one by hand, retyping each column off the domain, dropping it, and creating it again over the new base, or give the new domain another name.`,
    );
  });
});
