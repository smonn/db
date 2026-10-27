import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { relabeled } from "./enums.test-helper.ts";
import { refuseTypeChanges } from "./type-refusals.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

/** The database as it is, and the same with the enum `mood` swapped, as the Definition has it. */
async function swapped(sql: string): Promise<{ from: Catalog; to: Catalog }> {
  await db.driver.execute(sql);
  const from = await introspect(db.driver);
  return { from, to: relabeled(from, ["c", "b", "a"]) };
}

/** `catalog` without the stored generation of every column, as a Definition leaves a column. */
function ungenerated(catalog: Catalog): Catalog {
  return new Map([...catalog].filter(([, fact]) => fact.kind !== "generated"));
}

/** What `expect(...).toThrow` calls, so a void call isn't an arrow function's result. */
function refusing(catalogs: { from: Catalog; to: Catalog }): () => void {
  return () => {
    refuseTypeChanges(catalogs);
  };
}

const MOOD = "create type mood as enum ('a', 'b', 'c');";

describe("refuseTypeChanges for an enum swap under a stored generated column", () => {
  it("refuses a column of the enum, naming the table and column", async () => {
    const catalogs = await swapped(`${MOOD}
      create table users (
        id integer,
        mood mood,
        feeling mood generated always as (mood) stored,
        other mood
      )`);

    expect(refusing(catalogs)).toThrow(
      /^Generate can't remove or reorder a label of the enum "public"\."mood" while a stored generated column has its type: "public"\."users"\."feeling"\. Postgres can't retype a generated column with USING, which the swap needs\. Generate wrote no migration: write this one by hand, dropping each column before the swap and adding it again after, or drop the columns in an earlier migration\.$/u,
    );
  });

  it("refuses a column of an array of the enum", async () => {
    const catalogs = await swapped(`${MOOD}
      create table users (
        mood mood,
        feelings mood[] generated always as (array[mood]) stored
      )`);

    expect(refusing(catalogs)).toThrow(
      /while a stored generated column has its type: "public"\."users"\."feelings"\./u,
    );
  });

  it("names every such column, across tables", async () => {
    const catalogs = await swapped(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored);
      create table pets (mood mood, feelings mood[] generated always as (array[mood]) stored)`);

    expect(refusing(catalogs)).toThrow(
      /: "public"\."pets"\."feelings", "public"\."users"\."feeling"\. /u,
    );
  });

  it("leaves a swap beside a generated column of another type", async () => {
    const catalogs = await swapped(`${MOOD}
      create table users (mood mood, n integer, doubled integer generated always as (n * 2) stored)`);

    expect(refusing(catalogs)).not.toThrow();
  });

  it("leaves a generated column of an enum that doesn't swap", async () => {
    const catalogs = await swapped(`${MOOD}
      create type size as enum ('s', 'm');
      create table users (mood mood, big size generated always as ('m') stored)`);

    expect(refusing(catalogs)).not.toThrow();
  });

  it("leaves a column the Definition makes plain, since the diff drops its expression first", async () => {
    const { from, to } = await swapped(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored)`);

    expect(refusing({ from, to: ungenerated(to) })).not.toThrow();
  });

  it("leaves a column the Definition drops", async () => {
    const { from, to } = await swapped(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored)`);
    const gone = new Map(
      [...to].filter(([key]) => !String(key).startsWith("public\0users\0feeling")),
    );

    expect(refusing({ from, to: gone })).not.toThrow();
  });

  it("leaves a column the Definition gives another type, which the swap doesn't retype", async () => {
    await db.driver.execute(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored)`);
    const from = await introspect(db.driver);
    await db.driver.execute(`alter table users drop column feeling;
      alter table users add column feeling text generated always as ('m') stored`);
    const to = relabeled(await introspect(db.driver), ["c", "b", "a"]);

    expect(refusing({ from, to })).not.toThrow();
  });

  it("leaves an enum change that ADD VALUE reaches", async () => {
    await db.driver.execute(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored)`);
    const from = await introspect(db.driver);

    expect(refusing({ from, to: relabeled(from, ["a", "b", "c", "d"]) })).not.toThrow();
  });

  it("matches the failure Postgres gives the retype", async () => {
    const catalogs = await swapped(`${MOOD}
      create table users (mood mood, feeling mood generated always as (mood) stored)`);

    expect(refusing(catalogs)).toThrow(/a stored generated column/u);
    await expect(
      db.driver.execute(
        `alter type mood rename to mood_old;
         create type mood as enum ('c', 'b', 'a');
         alter table users alter column feeling type mood using feeling::text::mood`,
      ),
    ).rejects.toThrow(/cannot specify USING when altering type of generated column/u);
  });
});
