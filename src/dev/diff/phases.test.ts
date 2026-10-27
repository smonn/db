import { describe, expect, it } from "vitest";
import type { ActionKind } from "./actions.ts";
import { PLACES, type PlaceTable } from "./phases.ts";

/** A kind the diff doesn't have yet, such as a view rename. */
type Future = ActionKind | "rename view";

describe("the place of each action kind", () => {
  it("fails to compile until a new kind names its phase", () => {
    const complete: PlaceTable<Future> = { ...PLACES, "rename view": ["rename", 1] };

    // @ts-expect-error -- no place for the new kind.
    const none: PlaceTable<Future> = { ...PLACES };

    // @ts-expect-error -- a phase the phase table doesn't list.
    const unlisted: PlaceTable<Future> = { ...PLACES, "rename view": ["renames", 0] };

    expect([complete, none, unlisted]).toHaveLength(3);
  });

  it("places each kind in the phase and rank diff-engine.md lists", () => {
    expect(
      Object.entries(PLACES).map(([kind, [phase, rank]]) => [kind, phase, rank]),
    ).toStrictEqual([
      ["rename table", "rename", 0],
      ["rename column", "rename", 2],
      ["rename enum", "rename", 4],
      ["rename enum label", "rename", 5],
      ["rename domain", "rename", 6],
      ["rename enum aside", "rename", 8],
      ["rename replaced type", "rename", 8],
      ["rename domain check", "rename by payload", 0],
      ["rename constraint", "rename by payload", 1],
      ["rename index", "rename by payload", 2],
      ["rename sequence", "rename by payload", 3],
      ["drop foreign key", "drop key or index", 0],
      ["drop index", "drop key or index", 1],
      ["drop unique", "drop key or index", 2],
      ["drop primary key", "drop key or index", 3],
      ["drop column", "drop column or table", 0],
      ["drop table", "drop column or table", 1],
      ["create schema", "create or alter schema or type", 0],
      ["create enum", "create or alter schema or type", 2],
      ["add enum value", "create or alter schema or type", 5],
      ["create domain", "create or alter schema or type", 6],
      ["drop domain check", "create or alter schema or type", 6],
      ["alter domain default", "create or alter schema or type", 7],
      ["alter domain not null", "create or alter schema or type", 7],
      ["add domain check", "create or alter schema or type", 8],
      ["create table", "create or alter table", 0],
      ["add column", "create or alter table", 1],
      ["drop default", "create or alter table", 2],
      ["drop identity", "create or alter table", 3],
      ["drop expression", "create or alter table", 3],
      ["alter type", "create or alter table", 4],
      ["swap retype", "create or alter table", 4],
      ["set not null", "create or alter table", 5],
      ["drop not null", "create or alter table", 5],
      ["set default", "create or alter table", 6],
      ["set expression", "create or alter table", 6],
      ["add identity", "create or alter table", 7],
      ["set identity mode", "create or alter table", 7],
      ["add primary key", "add key or index", 0],
      ["add unique", "add key or index", 1],
      ["add index", "add key or index", 2],
      ["add foreign key", "add key or index", 3],
      ["drop domain", "drop type", 0],
      ["drop enum", "drop type", 2],
      ["drop enum aside", "drop type", 2],
      ["drop replaced type", "drop type", 2],
      ["drop schema", "drop schema", 0],
    ]);
  });
});
