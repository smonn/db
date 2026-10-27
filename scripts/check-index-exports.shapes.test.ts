import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exportedNames, main } from "./check-index-exports.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>(actual.readFileSync) };
});

describe("exportedNames", () => {
  test("reads names only from named re-exports", () => {
    const text = [
      'import { a } from "./a.ts";',
      "const b = 1;",
      "export { b };",
      'export * from "./c.ts";',
      'export * as ns from "./d.ts";',
      'export { e, type F } from "./e.ts";',
    ].join("\n");
    expect(exportedNames(text)).toEqual(["b", "e", "type F"]);
  });

  test("skips a statement that is not an export", () => {
    expect(exportedNames('import { a } from "./a.ts";\nconst b = 1;')).toEqual([]);
  });

  test("skips a namespace re-export", () => {
    expect(exportedNames('export * as ns from "./a.ts";')).toEqual([]);
  });
});

describe("main", () => {
  let root: string;

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-index-exports-shapes-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("does not count the names of the modules a group leaves out", () => {
    write("src/runtime/index.ts", 'export { secret } from "./internal/index.ts";\n');
    write("src/runtime/internal/index.ts", 'export { secret } from "./secret.ts";\n');
    write("src/dev/index.ts", "");
    main(root);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "src/runtime/index.ts: exports secret, which no module's index.ts exports",
    );
    expect(process.exitCode).toBe(1);
  });

  test("counts the names of the modules a group keeps", () => {
    write("src/runtime/index.ts", 'export { shown } from "./sql/index.ts";\n');
    write("src/runtime/sql/index.ts", 'export { shown } from "./shown.ts";\n');
    write("src/dev/index.ts", "");
    main(root);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("reads every file as UTF-8 text", () => {
    write("src/runtime/index.ts", 'export { shown } from "./sql/index.ts";\n');
    write("src/runtime/sql/index.ts", 'export { shown } from "./shown.ts";\n');
    write("src/dev/index.ts", "");
    vi.mocked(readFileSync).mockClear();
    main(root);
    const encodings = vi.mocked(readFileSync).mock.calls.map(([, encoding]) => encoding);
    expect(encodings.length).toBeGreaterThanOrEqual(5);
    expect(new Set(encodings)).toEqual(new Set(["utf8"]));
  });
});
