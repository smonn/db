import { describe, expect, test } from "vitest";
import { mapOutput, parseBlocks, sourcesFor, specifierPaths } from "./check-readme-examples.ts";

const fence = "```";
const NEEDS_TAG = "a ts block needs exactly one of file=<path> or wrap=table|type|module";
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
      `R.md:1: ${NEEDS_TAG}`,
      `R.md:4: ${NEEDS_TAG}`,
      "R.md:7: wrap=row is not one of table, type, module",
      "R.md:10: file=../a.ts must be a relative .ts path inside the project",
      "R.md:13: file=/a.ts must be a relative .ts path inside the project",
      "R.md:16: file=a.js must be a relative .ts path inside the project",
    ]);
  });

  test("rejects an info word that is neither file= nor wrap=, and a repeated key", () => {
    const text = doc(
      ...block("wrap=table wrap=type", "a"),
      ...block("wrap=table bogus=1 oops", "b"),
      ...block("file=a.ts file=b.ts", "c"),
      ...block("file=a.ts typo", "d"),
    );
    expect(parseBlocks(text, "R.md").problems).toEqual([
      "R.md:1: wrap= is given twice",
      "R.md:4: bogus=1 is not file=<path> or wrap=table|type|module",
      "R.md:7: file= is given twice",
      "R.md:10: typo is not file=<path> or wrap=table|type|module",
    ]);
  });

  test("holds a typescript fence to the same tag rule as ts", () => {
    const text = doc("```typescript", "a", fence, "```typescript wrap=type", "b", fence);
    expect(parseBlocks(text, "R.md")).toMatchObject({
      blocks: [{ line: 4 }],
      problems: [`R.md:1: ${NEEDS_TAG}`],
    });
  });

  test("closes a block at a fence with trailing whitespace", () => {
    const text = doc("```ts wrap=table", "a", "```  ", "```ts", "b", fence);
    const { blocks, problems } = parseBlocks(text, "R.md");
    expect(blocks).toEqual([{ line: 1, body: "a\n", target: { wrap: "table" } }]);
    expect(problems).toEqual([`R.md:4: ${NEEDS_TAG}`]);
  });

  test("reports a fence left open, at its opening line", () => {
    const ts = parseBlocks(doc("intro", "```ts wrap=table", "a", "```sh", "b"), "R.md");
    expect(ts).toEqual({ blocks: [], problems: ["R.md:2: the ts block is never closed"] });
    const sh = parseBlocks(doc("```sh", "x"), "R.md").problems;
    expect(sh).toEqual(["R.md:1: the sh block is never closed"]);
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
