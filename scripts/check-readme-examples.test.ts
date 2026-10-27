import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  main,
  mapOutput,
  parseBlocks,
  sourcesFor,
  specifierPaths,
} from "./check-readme-examples.ts";

const fence = "```";
const doc = (...rows: string[]): string => `${rows.join("\n")}\n`;
const block = (info: string, ...body: string[]): string[] => [
  `${fence}ts${info === "" ? "" : ` ${info}`}`,
  ...body,
  fence,
];

describe("parseBlocks", () => {
  test("reads file= and wrap= blocks with the line of their opening fence", () => {
    const text = doc(
      "# Title",
      ...block("file=db/a.ts", "const a = 1;"),
      "",
      ...block("wrap=table", "users: 1,", "posts: 2,"),
    );
    expect(parseBlocks(text, "R.md")).toEqual({
      blocks: [
        { line: 2, body: "const a = 1;\n", target: { file: "db/a.ts" } },
        { line: 6, body: "users: 1,\nposts: 2,\n", target: { wrap: "table" } },
      ],
      problems: [],
    });
  });

  test("skips fences in other languages, and a ts fence inside one", () => {
    const text = doc("```sh", "pnpm add x", fence, "```text", "```ts", "x", fence, "```tsx", fence);
    expect(parseBlocks(text, "R.md")).toEqual({ blocks: [], problems: [] });
  });

  test("names the README line of each untagged or badly tagged block", () => {
    const text = doc(
      ...block("", "a"),
      ...block("file=a.ts wrap=type", "b"),
      ...block("wrap=row", "c"),
      ...block("file=../a.ts", "d"),
      ...block("file=/a.ts", "e"),
      ...block("file=a.js", "f"),
    );
    expect(parseBlocks(text, "R.md").problems).toEqual([
      "R.md:1: a ts block needs exactly one of file=<path> or wrap=table|type|module",
      "R.md:4: a ts block needs exactly one of file=<path> or wrap=table|type|module",
      "R.md:7: wrap=row is not one of table, type, module",
      "R.md:10: file=../a.ts must be a relative .ts path inside the project",
      "R.md:13: file=/a.ts must be a relative .ts path inside the project",
      "R.md:16: file=a.js must be a relative .ts path inside the project",
    ]);
  });

  test("accepts every wrap tag", () => {
    const text = doc(
      ...block("wrap=table", "a"),
      ...block("wrap=type", "b"),
      ...block("wrap=module", "c"),
    );
    const targets = parseBlocks(text, "R.md").blocks.map((b) => b.target);
    expect(targets).toEqual([{ wrap: "table" }, { wrap: "type" }, { wrap: "module" }]);
  });
});

const blocks = (
  text: string,
): { label: string; blocks: ReturnType<typeof parseBlocks>["blocks"] }[] => [
  { label: "R.md", blocks: parseBlocks(text, "R.md").blocks },
];

describe("sourcesFor", () => {
  test("writes a file= block as is and a fragment inside its wrapper", () => {
    const { sources, problems } = sourcesFor(
      blocks(
        doc(
          ...block("file=a.ts", "export {};"),
          ...block("wrap=table", "t: 1,"),
          ...block("wrap=module", "m;"),
        ),
      ),
    );
    expect(problems).toEqual([]);
    expect(sources.get("a.ts")?.text).toBe("export {};\n");
    const table = sources.get("block-1.ts");
    expect(table?.text).toContain(
      'from "@smonn/db";\nexport default defineDatabase({\n  public: {\nt: 1,\n  },\n});\n',
    );
    expect(table?.offset).toBe(3);
    const module = sources.get("block-2.ts");
    expect(module?.text.endsWith('from "@smonn/db";\nm;\n')).toBe(true);
    expect(module?.offset).toBe(1);
  });

  test("wraps a type fragment in a schema, like a table", () => {
    const { sources } = sourcesFor(blocks(doc(...block("wrap=type", "e: 1,"))));
    expect(sources.get("block-0.ts")?.text).toContain("public: {\ne: 1,\n  },");
  });

  test("reports a path two blocks write", () => {
    const { problems } = sourcesFor(
      blocks(doc(...block("file=a.ts", "1;"), ...block("file=a.ts", "2;"))),
    );
    expect(problems).toEqual(["R.md:4: a.ts is already written by another block"]);
  });
});

describe("mapOutput", () => {
  const sources = sourcesFor([
    {
      label: "R.md",
      blocks: parseBlocks(doc("x", ...block("wrap=module", "a;", "b;")), "R.md").blocks,
    },
    { label: "R.md", blocks: [{ line: 20, body: "c;\n", target: { file: "q.ts" } }] },
  ]).sources;
  const project = "/tmp/check-readme-examples-abc";

  test("rewrites a position in a fragment to the README line of that body line", () => {
    const output = "../../tmp/check-readme-examples-abc/block-0.ts(3,5): error TS1: bad";
    expect(mapOutput(output, sources, project)).toBe("R.md:4: error TS1: bad");
    expect(mapOutput(output.replace("(3,", "(2,"), sources, project)).toBe(
      "R.md:3: error TS1: bad",
    );
  });

  test("rewrites a position in a file= block", () => {
    expect(mapOutput("q.ts(1,1): error TS1: bad", sources, "/tmp/p")).toBe(
      "R.md:21: error TS1: bad",
    );
  });

  test("names the fence when the error is in the wrapper, not the body", () => {
    const first = "check-readme-examples-abc/block-0.ts(1,1): error TS1: bad";
    const after = "check-readme-examples-abc/block-0.ts(4,1): error TS1: bad";
    expect(mapOutput(first, sources, project)).toBe("R.md:2: error TS1: bad");
    expect(mapOutput(after, sources, project)).toBe("R.md:2: error TS1: bad");
  });

  test("leaves a position outside the README blocks alone", () => {
    const output = "src/runtime/index.ts(1,2): error TS1: bad\n  continuation";
    expect(mapOutput(output, sources, project)).toBe(output);
  });
});

describe("specifierPaths", () => {
  test("maps each export that points at a built entry to its source", () => {
    const exports = {
      ".": "./dist/index.mjs",
      "./dev": "./dist/dev.mjs",
      "./cli": "./dist/cli.mjs",
      "./package.json": "./package.json",
      "./nested": { import: "./dist/index.mjs" },
    };
    expect(specifierPaths("@x/y", exports, { index: "src/i.ts", dev: "src/d.ts" }, "/r")).toEqual({
      "@x/y": ["/r/src/i.ts"],
      "@x/y/dev": ["/r/src/d.ts"],
    });
  });
});

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
