import { describe, expect, test } from "vitest";
import {
  checkAdrBody,
  checkAdrNumbers,
  checkAvoidTerms,
  checkEmDashes,
  checkGlossary,
  checkHeadwordCase,
  parseGlossary,
} from "./check-docs.ts";

const glossaryText = `# Glossary

**Schema**:
A Postgres namespace.
_Avoid_: Namespace

**Current migration**:
The in-progress Migration.
_Avoid_: Draft, pending migration
`;

const glossary = parseGlossary(glossaryText);

describe("parseGlossary", () => {
  test("reads each entry's headword, avoid terms, and line span", () => {
    expect(glossary).toEqual([
      { headword: "Schema", avoid: ["Namespace"], startLine: 3, endLine: 5 },
      {
        headword: "Current migration",
        avoid: ["Draft", "pending migration"],
        startLine: 7,
        endLine: 9,
      },
    ]);
  });
});

describe("checkGlossary", () => {
  test("passes when no avoid term is a headword", () => {
    expect(checkGlossary(glossary)).toEqual([]);
  });

  test("flags an avoid term that is also a headword", () => {
    const entries = parseGlossary(`**Schema**:
A namespace.

**Definition**:
The description.
_Avoid_: schema, schema file
`);
    expect(checkGlossary(entries)).toEqual([
      { file: "GLOSSARY.md", line: 6, message: '"schema" is avoided but is also a glossary term' },
    ]);
  });
});

describe("checkAvoidTerms", () => {
  test("flags avoid terms case-insensitively, including plurals", () => {
    const text = "Drafts are fine.\nA Pending Migrations list.\nNo match in redrafted.";
    expect(checkAvoidTerms("docs/a.md", text, glossary)).toEqual([
      { file: "docs/a.md", line: 1, message: 'avoid "Draft" (use "Current migration")' },
      {
        file: "docs/a.md",
        line: 2,
        message: 'avoid "pending migration" (use "Current migration")',
      },
    ]);
  });

  test("allows an avoid term inside its own glossary entry only", () => {
    const text = `${glossaryText}\nA namespace again.\n`;
    expect(checkAvoidTerms("GLOSSARY.md", text, glossary)).toEqual([
      { file: "GLOSSARY.md", line: 11, message: 'avoid "Namespace" (use "Schema")' },
    ]);
  });
});

describe("checkHeadwordCase", () => {
  test("flags case variants of a multi-word headword, including plurals", () => {
    const text = "The current migration.\nTwo Current Migrations here.";
    expect(checkHeadwordCase("docs/a.md", text, glossary)).toEqual([
      { file: "docs/a.md", line: 1, message: 'write "Current migration", not "current migration"' },
      {
        file: "docs/a.md",
        line: 2,
        message: 'write "Current migration", not "Current Migration"',
      },
    ]);
  });

  test("passes the headword's own case and plural", () => {
    const text = "The Current migration's hash.\nOld Current migrations.";
    expect(checkHeadwordCase("docs/a.md", text, glossary)).toEqual([]);
  });

  test("ignores code spans and single-word headwords", () => {
    const text = "Run `current migration` in a schema.";
    expect(checkHeadwordCase("docs/a.md", text, glossary)).toEqual([]);
  });
});

describe("checkEmDashes", () => {
  test("flags each line with an em-dash", () => {
    expect(checkEmDashes("a.md", "fine\nnot \u2014 fine\n")).toEqual([
      { file: "a.md", line: 2, message: "em-dash" },
    ]);
  });
});

describe("checkAdrBody", () => {
  const adr = (body: string) => `---
status: proposed
---

# Title

${body}

## Considered Options

One. Two. Three. Four.
`;

  test("passes a body of three sentences", () => {
    const text = adr("One sentence, with `x.y` code. Two runs v0.1 here! Three?");
    expect(checkAdrBody("docs/adr/0001-x.md", text)).toEqual([]);
  });

  test("ignores HTML comments", () => {
    const text = adr("One. Two. Three.\n\n<!--\nHidden. Notes. Here.\n-->");
    expect(checkAdrBody("docs/adr/0001-x.md", text)).toEqual([]);
  });

  test("flags a body over three sentences", () => {
    const text = adr("One. Two.\nThree. Four.");
    expect(checkAdrBody("docs/adr/0001-x.md", text)).toEqual([
      {
        file: "docs/adr/0001-x.md",
        line: 5,
        message: "ADR body has 4 sentences; the template allows 3",
      },
    ]);
  });
});

describe("checkAdrNumbers", () => {
  test("passes distinct numbers", () => {
    expect(checkAdrNumbers(["docs/adr/0001-a.md", "docs/adr/0002-b.md"])).toEqual([]);
  });

  test("flags every ADR after the first that reuses a number", () => {
    expect(
      checkAdrNumbers(["docs/adr/0011-a.md", "docs/adr/0011-b.md", "docs/adr/0012-c.md"]),
    ).toEqual([
      {
        file: "docs/adr/0011-b.md",
        line: 1,
        message: "ADR number 0011 is also used by docs/adr/0011-a.md",
      },
    ]);
  });
});
