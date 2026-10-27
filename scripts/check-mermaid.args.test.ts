import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-mermaid.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>(actual.readFileSync) };
});

const ok: SpawnSyncReturns<string> = {
  pid: 0,
  output: [],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
};

describe("main's mmdc calls", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "check-mermaid-args-")));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "a.md"), "```mermaid\ngraph TD\n```\n");
    writeFileSync(join(root, "docs/c.md"), "```mermaid\ngraph LR\n```\n");
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue(ok);
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  test("passes quiet mode, the puppeteer config, and a numbered output beside it", () => {
    main(root);
    const [first, second] = vi.mocked(spawnSync).mock.calls;
    const config = String(first?.[1]?.[2]);
    const outDir = dirname(config);
    expect(first).toEqual([
      "mmdc",
      ["-q", "-p", config, "-i", join(root, "a.md"), "-o", join(outDir, "0.md")],
      { stdio: "inherit" },
    ]);
    expect(second?.[1]).toEqual([
      "-q",
      "-p",
      config,
      "-i",
      join(root, "docs/c.md"),
      "-o",
      join(outDir, "1.md"),
    ]);
  });

  test("keeps its files in a check-mermaid- folder under the system's temp folder", () => {
    main(root);
    const config = String(vi.mocked(spawnSync).mock.calls[0]?.[1]?.[2]);
    expect(basename(config)).toBe("puppeteer.json");
    expect(dirname(dirname(config))).toBe(tmpdir());
    expect(basename(dirname(config)).startsWith("check-mermaid-")).toBe(true);
  });

  test("reads each Markdown file as UTF-8 text", () => {
    vi.mocked(readFileSync).mockClear();
    main(root);
    const encodings = vi.mocked(readFileSync).mock.calls.map(([, encoding]) => encoding);
    expect(encodings).toContain("utf8");
    expect(new Set(encodings)).toEqual(new Set(["utf8"]));
  });

  test("cleans up even when its temp folder is already gone", () => {
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      rmSync(dirname(String(args?.[2])), { recursive: true, force: true });
      return ok;
    });
    expect(() => {
      main(root);
    }).not.toThrow();
  });
});
