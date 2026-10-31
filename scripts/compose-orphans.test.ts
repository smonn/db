import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { orphanedProjects, worktreesFolder } from "./compose-orphans.ts";

const worktrees = join("/code", "db", ".claude", "worktrees");
const gone = join(worktrees, "gone", "compose.yaml");
const live = join(worktrees, "live", "compose.yaml");
const exists = (file: string): boolean => file === live;

// `docker compose ls --all --format json` lists each project's config files, comma-separated.
function listing(...projects: { name: string; files: string[] }[]): string {
  return JSON.stringify(
    projects.map(({ name, files }) => ({
      Name: name,
      Status: "running(1)",
      ConfigFiles: files.join(","),
    })),
  );
}

describe("worktreesFolder", () => {
  test("is the repo root's .claude/worktrees", () => {
    expect(worktreesFolder(join("/code", "db"))).toBe(worktrees);
  });

  test("is the same from inside one of the repo's worktrees", () => {
    expect(worktreesFolder(join(worktrees, "mine"))).toBe(worktrees);
  });
});

describe("orphanedProjects", () => {
  test("names a project whose config file under the worktrees folder is gone", () => {
    const projects = listing(
      { name: "t71", files: [gone] },
      { name: "smonn-t59", files: [join(worktrees, "gone-too", "compose.yaml")] },
    );

    expect(orphanedProjects(projects, worktrees, exists)).toEqual(["t71", "smonn-t59"]);
  });

  test("skips a project whose config file still exists", () => {
    expect(orphanedProjects(listing({ name: "live", files: [live] }), worktrees, exists)).toEqual(
      [],
    );
  });

  test("skips a project whose config file is outside the worktrees folder", () => {
    const projects = listing(
      { name: "elsewhere", files: [join("/code", "other", "compose.yaml")] },
      { name: "sibling", files: [join("/code", "db", ".claude", "worktrees-old", "compose.yaml")] },
      { name: "folder", files: [worktrees] },
    );

    expect(orphanedProjects(projects, worktrees, exists)).toEqual([]);
  });

  test("skips a project without config files", () => {
    expect(orphanedProjects(listing({ name: "none", files: [] }), worktrees, exists)).toEqual([]);
  });

  test("needs every config file to be under the folder and gone", () => {
    const outside = join("/code", "other", "compose.yaml");
    const projects = listing(
      { name: "half-live", files: [gone, live] },
      { name: "half-outside", files: [gone, outside] },
      { name: "both-gone", files: [gone, join(worktrees, "gone", "db.yaml")] },
    );

    expect(orphanedProjects(projects, worktrees, exists)).toEqual(["both-gone"]);
  });

  test.each([
    ["empty output", ""],
    ["text", "no daemon"],
    ["an object", '{"Name":"t71","ConfigFiles":"/x"}'],
    ["entries that are not objects", "[null,1]"],
    ["entries without a name", `[{"ConfigFiles":${JSON.stringify(gone)}}]`],
    ["entries without config files", '[{"Name":"t71"}]'],
    ["entries with a numeric name", `[{"Name":1,"ConfigFiles":${JSON.stringify(gone)}}]`],
  ])("names nothing for %s", (_, output) => {
    expect(orphanedProjects(output, worktrees, exists)).toEqual([]);
  });
});
