import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-mermaid.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const spawn = vi.mocked(spawnSync);
const ok = { status: 0 } as ReturnType<typeof spawnSync>;
const failed = { status: 1 } as ReturnType<typeof spawnSync>;
let root: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function argAfter(args: unknown, flag: string): string {
  const list = args as string[];
  return list[list.indexOf(flag) + 1] ?? "";
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-mermaid-test-")));
  write("a.md", "```mermaid\ngraph TD\n```\n");
  write("docs/b.md", "no diagrams here\n");
  write("docs/c.md", "```mermaid\ngraph LR\n```\n");
  spawn.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("main", () => {
  test("renders only the files with a Mermaid block", () => {
    spawn.mockReturnValue(ok);
    main(root);
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["mmdc", "mmdc"]);
    expect(spawn.mock.calls.map(([, args]) => argAfter(args, "-i"))).toEqual([
      join(root, "a.md"),
      join(root, "docs/c.md"),
    ]);
    expect(console.log).toHaveBeenCalledWith("Rendering a.md");
    expect(process.exitCode).toBeUndefined();
  });

  test("writes a no-sandbox puppeteer config and removes its temp directory", () => {
    let config = "";
    let configPath = "";
    spawn.mockImplementation((_command, args) => {
      configPath = argAfter(args, "-p");
      config = readFileSync(configPath, "utf8");
      return ok;
    });
    main(root);
    expect(JSON.parse(config)).toEqual({ args: ["--no-sandbox"] });
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  test("fails the run but still renders the rest when a block does not render", () => {
    spawn.mockReturnValueOnce(failed).mockReturnValueOnce(ok);
    main(root);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("a.md: a Mermaid block failed to render");
    expect(process.exitCode).toBe(1);
  });

  test("defaults to the working directory", () => {
    spawn.mockReturnValue(ok);
    main();
    const inputs = spawn.mock.calls.map(([, args]) => argAfter(args, "-i"));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => !isAbsolute(input) && input.endsWith(".md"))).toBe(true);
  });

  test("does nothing when no file has a Mermaid block", () => {
    write("a.md", "plain\n");
    write("docs/c.md", "plain\n");
    main(root);
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
