import { describe, expect, it } from "vitest";
import { defineDatabase, defineDomain, defineEnum } from "../../runtime/definition/index.ts";
import { catalogBuilder } from "./catalog.ts";
import type { Catalog } from "./fact.ts";
import { appliedRenames, declaredRenames } from "./renames.ts";
import type { DomainRename, EnumRename, LabelRename } from "./rename-types.ts";

function shadow(): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  builder.enumType("app", "old_mood", { labels: ["good", "bad"] });
  builder.domain("app", "old_posint", { base: "integer", notNull: false, default: null });
  return builder.build();
}

const renameEnum: EnumRename = { kind: "enum", schema: "app", name: "mood", was: "old_mood" };
const renameLabel: LabelRename = {
  kind: "enum label",
  schema: "app",
  enum: "mood",
  name: "great",
  was: "good",
};
const renameDomain: DomainRename = {
  kind: "domain",
  schema: "app",
  name: "posint",
  was: "old_posint",
};

describe("declaredRenames for types", () => {
  it("lists an enum's marker, then its labels', then each domain's", () => {
    const mood = defineEnum(["great", "bad"], {
      renamedFrom: "old_mood",
      renamedLabels: { great: "good" },
    });
    const posint = defineDomain((c) => c.integer(), { renamedFrom: "old_posint" });
    const plain = defineEnum(["a"]);

    expect(declaredRenames(defineDatabase({ app: { posint, mood, plain } }))).toStrictEqual([
      renameEnum,
      renameLabel,
      renameDomain,
    ]);
  });

  it("lists nothing without a marker", () => {
    const mood = defineEnum(["a"]);
    const posint = defineDomain((c) => c.integer());

    expect(declaredRenames(defineDatabase({ app: { mood, posint } }))).toStrictEqual([]);
  });
});

describe("appliedRenames for types", () => {
  it("applies each rename whose old name is in the Shadow and new name is not", () => {
    const applied = appliedRenames([renameEnum, renameLabel, renameDomain], shadow());

    expect(applied).toStrictEqual([renameEnum, renameLabel, renameDomain]);
  });

  it("finds a label in the enum under its old name until the enum renames", () => {
    expect(appliedRenames([renameLabel], shadow())).toStrictEqual([]);
    expect(appliedRenames([renameEnum, renameLabel], shadow())).toStrictEqual([
      renameEnum,
      renameLabel,
    ]);
  });

  it("skips a rename whose old name or label is gone", () => {
    const builder = catalogBuilder();
    builder.schema("app");
    builder.enumType("app", "mood", { labels: ["great", "bad"] });
    builder.domain("app", "posint", { base: "integer", notNull: false, default: null });

    expect(appliedRenames([renameEnum, renameLabel, renameDomain], builder.build())).toStrictEqual(
      [],
    );
  });

  it("throws when an enum's old and new names both exist", () => {
    const builder = catalogBuilder();
    builder.schema("app");
    builder.enumType("app", "old_mood", { labels: ["good"] });
    builder.enumType("app", "mood", { labels: ["good"] });

    expect(() => appliedRenames([renameEnum], builder.build())).toThrow(
      'enum "app"."mood" has renamedFrom "old_mood", but the Shadow database holds both',
    );
  });

  it("throws when a domain's old and new names both exist", () => {
    const builder = catalogBuilder();
    builder.schema("app");
    for (const name of ["old_posint", "posint"]) {
      builder.domain("app", name, { base: "integer", notNull: false, default: null });
    }

    expect(() => appliedRenames([renameDomain], builder.build())).toThrow(
      'domain "app"."posint" has renamedFrom "old_posint", but the Shadow database holds both',
    );
  });

  it("throws when a label's old and new names both exist", () => {
    const builder = catalogBuilder();
    builder.schema("app");
    builder.enumType("app", "mood", { labels: ["good", "great"] });

    expect(() => appliedRenames([renameLabel], builder.build())).toThrow(
      'enum "app"."mood" has renamedLabels "great" from "good", but the Shadow database holds both labels',
    );
  });
});
