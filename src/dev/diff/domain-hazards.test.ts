import { describe, expect, it } from "vitest";
import { HAZARD_KINDS, retypeHazards, type DomainType } from "./hazards.ts";

const rewrite = ["rewrite", "access_exclusive_lock"];
const enums = new Set(["public.mood"]);
const domains = new Map<string, DomainType>([
  ["public.plain", { base: "integer", constrained: false }],
  ["public.other", { base: "integer", constrained: false }],
  ["public.posint", { base: "integer", constrained: true }],
  ["public.calm", { base: "public.mood", constrained: false }],
  ["public.short", { base: "character varying(20)", constrained: false }],
]);
const hazards = (before: string, after: string) => retypeHazards(before, after, enums, domains);

describe("retypeHazards for domains", () => {
  it("carries none to an unconstrained domain over the same base, or from a domain to its base", () => {
    expect(hazards("integer", "public.plain")).toStrictEqual([]);
    expect(hazards("public.plain", "integer")).toStrictEqual([]);
    expect(hazards("public.posint", "integer")).toStrictEqual([]);
    expect(hazards("public.plain", "public.other")).toStrictEqual([]);
    expect(hazards("public.mood", "public.calm")).toStrictEqual([]);
  });

  it("rewrites to a constrained domain over the same base", () => {
    expect(hazards("integer", "public.posint")).toStrictEqual(rewrite);
    expect(hazards("public.plain", "public.posint")).toStrictEqual(rewrite);
  });

  it("carries every Hazard for a pair whose base doesn't match", () => {
    expect(hazards("bigint", "public.plain")).toStrictEqual(HAZARD_KINDS);
    expect(hazards("public.plain", "bigint")).toStrictEqual(HAZARD_KINDS);
    expect(hazards("text", "public.calm")).toStrictEqual(HAZARD_KINDS);
    expect(hazards("character varying(40)", "public.short")).toStrictEqual(HAZARD_KINDS);
  });

  it("rewrites any change to an array of a domain, keeping the element pair's other Hazards", () => {
    expect(hazards("integer[]", "public.plain[]")).toStrictEqual(rewrite);
    expect(hazards("public.posint[]", "integer[]")).toStrictEqual(rewrite);
    expect(hazards("bigint[]", "public.plain[]")).toStrictEqual(HAZARD_KINDS);
    expect(hazards("public.plain", "public.plain[]")).toStrictEqual(HAZARD_KINDS);
  });
});
