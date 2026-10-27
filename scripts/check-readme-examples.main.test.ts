import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-readme-examples.ts";

const fence = "```";
const doc = (...rows: string[]): string => `${rows.join("\n")}\n`;
const block = (info: string, ...body: string[]): string[] => [
  `${fence}ts${info === "" ? "" : ` ${info}`}`,
  ...body,
  fence,
];

describe("main", () => {
  let dir: string;
  let errors: string[];

  function check(...rows: string[]): void {
    const file = join(dir, "README.md");
    writeFileSync(file, doc(...rows));
    main([file]);
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "check-readme-examples-test-")));
    errors = [];
    vi.spyOn(console, "error").mockImplementation((message: string) => {
      errors.push(message);
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes file= blocks that import each other and the package, and every wrap", () => {
    check(
      ...block(
        "file=db/definition.ts",
        'import { defineDatabase, defineTable } from "@smonn/db";',
        "export default defineDatabase({ public: { t: defineTable((c) => ({ id: c.text().notNull() })) } });",
      ),
      ...block(
        "file=main.ts",
        'import { defineConfig } from "@smonn/db/dev";',
        'import postgres from "postgres";',
        'import db from "./db/definition.ts";',
        'export default [defineConfig({ definition: "./a.ts", migrations: "./m", url: process.env.DATABASE_URL }), postgres, db];',
      ),
      ...block("wrap=table", "users: defineTable((c) => ({ id: c.text().notNull() })),"),
      ...block("wrap=type", 'mood: defineEnum(["a", "b"]),'),
      ...block("wrap=module", "export default defineDatabase({ public: {} });"),
    );
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("names the README line of a type error in a fragment", () => {
    check(
      "intro",
      ...block("wrap=table", "users: defineTable((c) => ({", "  id: c.nope(),", "})),"),
    );
    expect(errors.join("\n")).toMatch(new RegExp(`README\\.md:4: error TS\\d+: .*nope`, "u"));
    expect(process.exitCode).toBe(1);
  });

  test("names the README line of a type error in a file= block", () => {
    check(...block("file=a.ts", "const a: number = 1;", 'const b: number = "x";'));
    expect(errors.join("\n")).toMatch(/README\.md:3: error TS2322/u);
    expect(process.exitCode).toBe(1);
  });

  test("fails an untagged ts block and a path two blocks write", () => {
    check(
      ...block("", "const a = 1;"),
      ...block("file=a.ts", "export {};"),
      ...block("file=a.ts", "export {};"),
    );
    expect(errors.join("\n")).toContain("README.md:1: a ts block needs exactly one of");
    expect(errors.join("\n")).toContain("README.md:7: a.ts is already written by another block");
    expect(process.exitCode).toBe(1);
  });

  test("fails a README whose only ts block is untagged, without running tsc", () => {
    check(...block("", "const a = 1;"));
    expect(errors).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  test("reports a tsc that cannot start, not null output", () => {
    writeFileSync(join(dir, "README.md"), doc(...block("wrap=module", "export {};")));
    main(["README.md"], dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^could not run tsc: .*ENOENT/u);
    expect(errors[0]).not.toContain("null");
    expect(process.exitCode).toBe(1);
  });

  test("passes a README with no ts block", () => {
    check("plain");
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("passes the repo README", () => {
    main();
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
