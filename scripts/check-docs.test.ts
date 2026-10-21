import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  main,
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

const adr = (body: string) => `---
status: proposed
---

# Title

${body}

## Considered Options

One. Two. Three. Four.
`;

describe("checkAdrBody", () => {
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

function reported(): string[] {
  return vi.mocked(console.error).mock.calls.map(([line]) => String(line));
}

describe("main", () => {
  const emDash = String.fromCodePoint(0x2014);
  let root: string;

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "check-docs-test-")));
    write("GLOSSARY.md", glossaryText);
    write("README.md", "A Schema holds tables.\n");
    write("docs/adr/0001-first.md", "# First\n\nOne sentence.\n\n## Status\n\naccepted\n");
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  test("passes a clean tree", () => {
    write("scripts/a.ts", "export const a = 1;\n");
    main(root);
    expect(reported()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("reports every kind of problem as file:line: message and exits 1", () => {
    write("README.md", `A Namespace ${emDash} here.\nA current Migration too.\n`);
    write("docs/adr/0001-second.md", "# Second\n\nOne. Two. Three. Four.\n");
    write("notes.md", `Namespace ${emDash}\n`);
    write("src/b.ts", `export const b = "${emDash}";\n`);
    main(root);
    expect(reported().toSorted()).toEqual(
      [
        "README.md:1: em-dash",
        'README.md:1: avoid "Namespace" (use "Schema")',
        'README.md:2: write "Current migration", not "current Migration"',
        "docs/adr/0001-second.md:1: ADR body has 4 sentences; the template allows 3",
        "docs/adr/0001-second.md:1: ADR number 0001 is also used by docs/adr/0001-first.md",
        "notes.md:1: em-dash",
        "src/b.ts:1: em-dash",
      ].toSorted(),
    );
    expect(process.exitCode).toBe(1);
  });

  test("flags a glossary term that is also avoided", () => {
    write("GLOSSARY.md", "**Schema**:\nA namespace.\n_Avoid_: Table\n\n**Table**:\nA relation.\n");
    main(root);
    expect(reported()).toContain('GLOSSARY.md:3: "Table" is avoided but is also a glossary term');
    expect(process.exitCode).toBe(1);
  });
});
