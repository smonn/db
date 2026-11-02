import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { orphanedProjects, projectPrefix } from "./compose-orphans.ts";

const claudeGone = join("/code", "db", ".claude", "worktrees", "gone", "compose.yaml");
const t3Gone = join("/home", "me", ".t3", "worktrees", "smonn-db", "t3-1a2b", "compose.yaml");
const live = join("/home", "me", ".t3", "worktrees", "smonn-db", "t3-live", "compose.yaml");
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

describe("orphanedProjects", () => {
  test("names a prefixed project whose config file is gone, from any folder", () => {
    const projects = listing(
      { name: `${projectPrefix}rustling`, files: [claudeGone] },
      { name: `${projectPrefix}t3-1a2b`, files: [t3Gone] },
      { name: `${projectPrefix}tmp`, files: [join("/tmp", "somewhere", "compose.yaml")] },
    );

    expect(orphanedProjects(projects, exists)).toEqual([
      `${projectPrefix}rustling`,
      `${projectPrefix}t3-1a2b`,
      `${projectPrefix}tmp`,
    ]);
  });

  test("skips a prefixed project whose config file still exists", () => {
    expect(
      orphanedProjects(listing({ name: `${projectPrefix}live`, files: [live] }), exists),
    ).toEqual([]);
  });

  test("skips a project without the prefix, even when its config file is gone", () => {
    const projects = listing(
      { name: "other-project", files: [t3Gone] },
      { name: `x${projectPrefix}t3-1a2b`, files: [t3Gone] },
      { name: projectPrefix.slice(0, -1), files: [t3Gone] },
    );

    expect(orphanedProjects(projects, exists)).toEqual([]);
  });

  test("skips a prefixed project without config files", () => {
    const projects = listing(
      { name: `${projectPrefix}none`, files: [] },
      { name: `${projectPrefix}blank`, files: [""] },
    );

    expect(orphanedProjects(projects, exists)).toEqual([]);
  });

  test("needs every config file to be gone", () => {
    const projects = listing(
      { name: `${projectPrefix}half-live`, files: [t3Gone, live] },
      { name: `${projectPrefix}live-first`, files: [live, t3Gone] },
      { name: `${projectPrefix}both-gone`, files: [t3Gone, claudeGone] },
    );

    expect(orphanedProjects(projects, exists)).toEqual([`${projectPrefix}both-gone`]);
  });

  test.each([
    ["empty output", ""],
    ["text", "no daemon"],
    ["an object", `{"Name":"${projectPrefix}t71","ConfigFiles":"/x"}`],
    ["entries that are not objects", "[null,1]"],
    ["entries without a name", `[{"ConfigFiles":${JSON.stringify(t3Gone)}}]`],
    ["entries without config files", `[{"Name":"${projectPrefix}t71"}]`],
    ["entries with a numeric name", `[{"Name":1,"ConfigFiles":${JSON.stringify(t3Gone)}}]`],
  ])("names nothing for %s", (_, output) => {
    expect(orphanedProjects(output, exists)).toEqual([]);
  });
});
