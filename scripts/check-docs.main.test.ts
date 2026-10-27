import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-docs.ts";

const glossary = `# Glossary

**Schema**:
A Postgres namespace.
_Avoid_: Namespace
`;

function reported(): string[] {
  return vi.mocked(console.error).mock.calls.map(([line]) => String(line));
}

describe("main file selection", () => {
  let root: string;

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "check-docs-files-")));
    write("GLOSSARY.md", glossary);
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  test("budgets the three architecture docs by default", () => {
    main(root);
    expect(reported()).toEqual(
      ["README.md", "cli.md", "diff-engine.md"].map(
        (name) =>
          `docs/architecture/${name}:1: budgeted file is missing; update its cap in scripts/check-docs.ts`,
      ),
    );
  });

  test("checks the glossary's own text outside its entries", () => {
    write("GLOSSARY.md", `${glossary}\nA namespace later.\n`);
    main(root, {});
    expect(reported()).toEqual(['GLOSSARY.md:7: avoid "Namespace" (use "Schema")']);
  });

  test("checks the README and anything under docs/, not other Markdown", () => {
    write("README.md", "A namespace.\n");
    write("docs/guide.md", "A namespace.\n");
    write("docs/nested/deep.md", "A namespace.\n");
    write("other/notes.md", "A namespace.\n");
    main(root, {});
    expect(reported().toSorted()).toEqual([
      'README.md:1: avoid "Namespace" (use "Schema")',
      'docs/guide.md:1: avoid "Namespace" (use "Schema")',
      'docs/nested/deep.md:1: avoid "Namespace" (use "Schema")',
    ]);
  });

  test("holds only files named like ADRs to the sentence limit", () => {
    const long = "# T\n\nOne. Two. Three. Four.\n";
    write("docs/adr/0001-real.md", long);
    write("docs/adr/TEMPLATE.md", long);
    write("docs/adr/notes/0002-x.md", long);
    write("other/docs/adr/0003-x.md", long);
    main(root, {});
    expect(reported()).toEqual([
      "docs/adr/0001-real.md:1: ADR body has 4 sentences; the template allows 3",
    ]);
  });
});
