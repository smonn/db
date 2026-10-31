import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./issue-section.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const reply = (stdout: string, status = 0, stderr = ""): SpawnSyncReturns<string> => ({
  pid: 0,
  output: [],
  stdout,
  stderr,
  status,
  signal: null,
});

const path = "repos/{owner}/{repo}/issues/5";
const read = (body: string | null) => reply(JSON.stringify({ body }));
const args = (...rest: string[]) => ["5", "--section", "## Decisions so far", ...rest];

describe("main", () => {
  const spawn = vi.mocked(spawnSync);
  let dir: string;
  let lines: string;

  beforeEach(() => {
    spawn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    dir = mkdtempSync(join(tmpdir(), "issue-section-"));
    lines = join(dir, "lines.md");
    writeFileSync(lines, "- new\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("reads the body, then writes it back with the lines appended", () => {
    spawn.mockReturnValueOnce(read("## Decisions so far\n\n- old\n\n## Fog\n"));
    spawn.mockReturnValueOnce(reply("{}"));
    main(args("--append", lines));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]).toEqual([
      "gh",
      ["api", path],
      { encoding: "utf8", input: undefined },
    ]);
    expect(spawn.mock.calls[1]).toEqual([
      "gh",
      ["api", "--method", "PATCH", path, "--input", "-"],
      {
        encoding: "utf8",
        input: JSON.stringify({ body: "## Decisions so far\n\n- old\n- new\n\n## Fog\n" }),
      },
    ]);
  });

  test("accepts the flags before the issue number", () => {
    spawn.mockReturnValueOnce(read("## Decisions so far\n- old\n"));
    spawn.mockReturnValueOnce(reply("{}"));
    main(["--append", lines, "--section", "## Decisions so far", "5"]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test("writes nothing and exits 1 when the issue has no body", () => {
    spawn.mockReturnValueOnce(read(null));
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(`${path} has no body`);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("takes its arguments from the command line by default", () => {
    const argv = process.argv;
    process.argv = ["node", "scripts/issue-section.ts", ...args("--append", lines)];
    spawn.mockReturnValueOnce(read("## Decisions so far\n- old\n"));
    spawn.mockReturnValueOnce(reply("{}"));
    try {
      main();
    } finally {
      process.argv = argv;
    }
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test("writes nothing and exits 1 when the heading is missing", () => {
    spawn.mockReturnValueOnce(read("## Fog\n- x\n"));
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(
      'no "## Decisions so far" heading in the issue body',
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("writes nothing and exits 1 when the append file is missing or empty", () => {
    expect(() => {
      main(args("--append", join(dir, "absent.md")));
    }).toThrow("exit 1");
    writeFileSync(lines, "\n");
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenLastCalledWith(`${lines} has no lines to append`);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("keeps blank lines between the lines it appends", () => {
    writeFileSync(lines, "- a\n\n- b\n");
    spawn.mockReturnValueOnce(read("## Decisions so far\n- old\n"));
    spawn.mockReturnValueOnce(reply("{}"));
    main(args("--append", lines));
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({
      input: JSON.stringify({ body: "## Decisions so far\n- old\n- a\n\n- b\n" }),
    });
  });

  test("writes nothing when the append file holds only blanks", () => {
    writeFileSync(lines, "  \n");
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(`${lines} has no lines to append`);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("prints the gh error and exits 1 when the read fails", () => {
    spawn.mockReturnValueOnce(reply("", 1, " HTTP 404 \n"));
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(`gh api ${path} failed:\nHTTP 404`);
  });

  test("prints the gh error and exits 1 when the write fails", () => {
    spawn.mockReturnValueOnce(read("## Decisions so far\n- old\n"));
    spawn.mockReturnValueOnce(reply("", 1, "HTTP 403"));
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(
      `gh api --method PATCH ${path} --input - failed:\nHTTP 403`,
    );
  });

  test.each([
    ["not JSON", "oops", `gh api ${path}: invalid JSON`],
    ["a body that is not an object", "[]", "$: expected object, got array"],
    ["a body that is not text", '{"body":5}', "$.body: expected string, got number"],
  ])("exits 1 when the body read is %s", (_name, stdout, message) => {
    spawn.mockReturnValueOnce(reply(stdout));
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("prints a thrown non-Error value as is", () => {
    spawn.mockImplementation(() => {
      // oxlint-disable-next-line eslint/no-throw-literal, typescript/only-throw-error -- main's non-Error branch is the subject.
      throw "boom";
    });
    expect(() => {
      main(args("--append", lines));
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith("boom");
  });

  test.each([
    ["no arguments", []],
    ["a missing issue number", ["--section", "## A", "--append", "x"]],
    ["an issue number that is not a positive integer", ["0", "--section", "## A", "--append", "x"]],
    ["a fractional issue number", ["1.5", "--section", "## A", "--append", "x"]],
    ["a word for the issue number", ["abc", "--section", "## A", "--append", "x"]],
    ["two issue numbers", ["5", "6", "--section", "## A", "--append", "x"]],
    ["a missing --section", ["5", "--append", "x"]],
    ["a missing --append", ["5", "--section", "## A"]],
    ["an --append with no value", ["5", "--section", "## A", "--append"]],
    ["a section that is not a heading", ["5", "--section", "Decisions", "--append", "x"]],
    ["a heading with no text", ["5", "--section", "## ", "--append", "x"]],
    ["a heading of seven hashes", ["5", "--section", "####### A", "--append", "x"]],
    ["an unknown flag", ["5", "--section", "## A", "--append", "x", "--force"]],
  ])("prints usage and exits 2 for %s", (_name, argv) => {
    expect(() => {
      main(argv);
    }).toThrow("exit 2");
    expect(console.error).toHaveBeenCalledWith(
      'Usage: node scripts/issue-section.ts <issue number> --section "<## heading>" --append <line-file>',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
