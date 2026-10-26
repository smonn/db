import { globSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EXCLUDE, mutateGlobs, SHARDS } from "./mutation-shards.ts";

const excluded = EXCLUDE.map((glob) => glob.slice(1));
const expand = (globs: string[]): string[] => globSync(globs, { exclude: excluded });

describe("SHARDS", () => {
  test("mutate every source file in exactly one shard", () => {
    const shardFiles = Object.values(SHARDS)
      .flatMap((globs) => expand(globs))
      .toSorted();
    expect(shardFiles).toEqual(expand(["src/**/*.ts", "scripts/**/*.ts"]).toSorted());
  });

  test("match the Mutation workflow's matrix", () => {
    const workflow = readFileSync(".github/workflows/mutation.yml", "utf8");
    const matrix = /^\s+shard: \[(?<shards>[^\]]*)\]$/mu.exec(workflow)?.groups?.["shards"];
    expect(matrix?.split(", ")).toEqual(Object.keys(SHARDS));
  });
});

describe("mutateGlobs", () => {
  test("mutates every shard when no shard is set", () => {
    expect(mutateGlobs({})).toEqual([...Object.values(SHARDS).flat(), ...EXCLUDE]);
    expect(mutateGlobs({ MUTATION_SHARD: "" })).toEqual(mutateGlobs({}));
  });

  test("mutates one shard's files", () => {
    expect(mutateGlobs({ MUTATION_SHARD: "scripts" })).toEqual(["scripts/**/*.ts", ...EXCLUDE]);
  });

  test("names an unknown shard", () => {
    expect(() => mutateGlobs({ MUTATION_SHARD: "srcs" })).toThrow(
      'Unknown MUTATION_SHARD "srcs"; expected one of diff',
    );
  });
});
