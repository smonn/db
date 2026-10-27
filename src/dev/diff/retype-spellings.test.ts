import { describe, expect, it } from "vitest";
import { HAZARD_KINDS, retypeHazards } from "./hazards.ts";

const rewrite = ["rewrite", "access_exclusive_lock"];

describe("retypeHazards reading a spelling", () => {
  it("classifies only a spelling that is a whole varchar or numeric type", () => {
    expect(retypeHazards("my character varying(5)", "text")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("character varying(5) x", "text")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("my numeric(10,2)", "numeric")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("numeric(10,2) x", "numeric")).toStrictEqual(HAZARD_KINDS);
  });

  it("reads a numeric with a precision and no scale, or a scale of several digits", () => {
    expect(retypeHazards("numeric(10)", "numeric(12)")).toStrictEqual([]);
    expect(retypeHazards("numeric(30,12)", "numeric(32,12)")).toStrictEqual([]);
  });

  it("treats a scalar to an array, and back, as unclassified", () => {
    expect(retypeHazards("integer", "integer[]")).toStrictEqual(HAZARD_KINDS);
    expect(retypeHazards("integer[]", "integer")).toStrictEqual(HAZARD_KINDS);
  });
});

describe("retypeHazards for a varchar length", () => {
  it("rewrites only when the length shrinks or gets a bound", () => {
    expect(retypeHazards("character varying", "character varying")).toStrictEqual([]);
    expect(retypeHazards("character varying(5)", "character varying")).toStrictEqual([]);
    expect(retypeHazards("character varying", "character varying(5)")).toStrictEqual(rewrite);
    expect(retypeHazards("character varying(5)", "character varying(5)")).toStrictEqual([]);
  });
});

describe("retypeHazards for a numeric precision and scale", () => {
  it("rewrites a smaller precision, a changed scale, or a new bound, and nothing else", () => {
    expect(retypeHazards("numeric(10,2)", "numeric(8,2)")).toStrictEqual(rewrite);
    expect(retypeHazards("numeric(10,2)", "numeric(12,4)")).toStrictEqual(rewrite);
    expect(retypeHazards("numeric", "numeric(10,2)")).toStrictEqual(["data_loss", ...rewrite]);
    expect(retypeHazards("numeric(10,2)", "numeric(10,2)")).toStrictEqual([]);
  });
});

describe("retypeHazards for data loss", () => {
  it("doesn't flag text going to a date, or a numeric going to text", () => {
    expect(retypeHazards("text", "date")).toStrictEqual(rewrite);
    expect(retypeHazards("numeric(10,2)", "text")).toStrictEqual(rewrite);
  });
});
