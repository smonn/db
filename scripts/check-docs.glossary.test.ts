import { describe, expect, test } from "vitest";
import { checkAvoidTerms, checkHeadwordCase, parseGlossary } from "./check-docs.ts";

describe("parseGlossary line shapes", () => {
  test("reads an Avoid line in a file with CRLF line endings", () => {
    expect(parseGlossary("**Schema**:\r\nA namespace.\r\n_Avoid_: Namespace\r\n")).toEqual([
      { headword: "Schema", avoid: ["Namespace"], startLine: 1, endLine: 3 },
    ]);
  });

  test("reads an Avoid line with no space after the colon", () => {
    expect(parseGlossary("**Schema**:\n_Avoid_:Namespace\n")[0]?.avoid).toEqual(["Namespace"]);
  });

  test("leaves an entry with no Avoid line avoiding nothing", () => {
    expect(parseGlossary("**Schema**:\nA namespace.\n")).toEqual([
      { headword: "Schema", avoid: [], startLine: 1, endLine: 2 },
    ]);
  });

  test("reads an Avoid line only at the start of a line", () => {
    expect(parseGlossary("**Schema**:\nsee _Avoid_: Namespace\n")[0]?.avoid).toEqual([]);
  });

  test("takes a headword only from a line holding nothing else", () => {
    const text = "**Schema**: a namespace\nsee **Table**:\n**Index**:  \n";
    expect(parseGlossary(text).map((entry) => entry.headword)).toEqual(["Index"]);
  });

  test("ends an entry at the first blank line, even one of spaces", () => {
    const text = "**Schema**:\nA namespace.\n  \n_Avoid_: Namespace\n\nstray\n_Avoid_: Stray\n";
    expect(parseGlossary(text)).toEqual([
      { headword: "Schema", avoid: [], startLine: 1, endLine: 2 },
    ]);
  });
});

describe("checkAvoidTerms matching", () => {
  const entries = [{ headword: "Dot", avoid: ["a.b", "c++"], startLine: 1, endLine: 3 }];

  test("reads a term's punctuation literally", () => {
    const text = "axb is fine.\na.b is not.\nc+ and c++ differ.";
    expect(checkAvoidTerms("docs/a.md", text, entries).map(({ line }) => line)).toEqual([2]);
  });

  test("skips an entry's own lines only in GLOSSARY.md, from its headword line on", () => {
    const text = "a.b\na.b\na.b\na.b";
    const lines = (file: string, from: number) =>
      checkAvoidTerms(file, text, [
        { headword: "Dot", avoid: ["a.b"], startLine: from, endLine: 3 },
      ]).map(({ line }) => line);
    expect(lines("GLOSSARY.md", 1)).toEqual([4]);
    expect(lines("GLOSSARY.md", 2)).toEqual([1, 4]);
    expect(lines("docs/a.md", 1)).toEqual([1, 2, 3, 4]);
  });
});

describe("checkHeadwordCase matching", () => {
  const entries = parseGlossary("**Current migration**:\nThe in-progress Migration.\n");

  test("does not join words across a code span", () => {
    expect(checkHeadwordCase("docs/a.md", "current `x`migration", entries)).toEqual([]);
  });

  test("skips a code span of any length", () => {
    expect(
      checkHeadwordCase("docs/a.md", "`current migration` and `current` `migration`", entries),
    ).toEqual([]);
  });
});
