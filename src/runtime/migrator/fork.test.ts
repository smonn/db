import { describe, expect, it } from "vitest";
import { parseMigration, writeMigration } from "../internal/index.ts";
import { findForks } from "./fork.ts";

async function parsed(filename: string, previous: string | undefined, body: string) {
  return parseMigration(await writeMigration(filename, previous, body));
}

const A = await parsed("000001-a.sql", undefined, "create table a (n int);\n");
const B = await parsed("000002-b.sql", A.hash, "create table b (n int);\n");
const X = await parsed("000002-x.sql", A.hash, "create table x (n int);\n");
const Y = await parsed("000002-y.sql", A.hash, "create table y (n int);\n");
const X3 = await parsed("000003-x3.sql", X.hash, "create table x3 (n int);\n");
const R = await parsed("000001-r.sql", undefined, "create table r (n int);\n");
// Two parents that no file holds, each followed by two files at sequence 5.
const GONE = await parsed("000004-gone.sql", A.hash, "create table gone (n int);\n");
const M1 = await parsed("000005-m1.sql", GONE.hash, "create table m1 (n int);\n");
const M2 = await parsed("000005-m2.sql", GONE.hash, "create table m2 (n int);\n");
const GONE2 = await parsed("000004-gone2.sql", A.hash, "create table gone2 (n int);\n");
const N1 = await parsed("000005-n1.sql", GONE2.hash, "create table n1 (n int);\n");
const N2 = await parsed("000005-n2.sql", GONE2.hash, "create table n2 (n int);\n");

describe("findForks", () => {
  it("finds nothing on a straight chain or an empty one", () => {
    expect(findForks([A, B])).toStrictEqual([]);
    expect(findForks([])).toStrictEqual([]);
  });

  it("names the shared parent and the files that follow it", () => {
    expect(findForks([A, X, B])).toStrictEqual([
      { parent: A, previous: A.hash, successors: [B, X] },
    ]);
  });

  it("lists every file of a three-way fork in sequence, then filename, order", () => {
    expect(findForks([Y, A, X, B])).toStrictEqual([
      { parent: A, previous: A.hash, successors: [B, X, Y] },
    ]);
  });

  it("keeps files that share a sequence and a filename in the order given", async () => {
    const twin = await parsed("000002-x.sql", A.hash, "create table twin (n int);\n");

    expect(findForks([X, twin])[0]?.successors).toStrictEqual([X, twin]);
    expect(findForks([twin, X])[0]?.successors).toStrictEqual([twin, X]);
  });

  it("finds a fork whose branches differ in length", () => {
    expect(findForks([A, X, X3, B])).toStrictEqual([
      { parent: A, previous: A.hash, successors: [B, X] },
    ]);
  });

  it("finds a fork at the start of the chain, which has no parent file", () => {
    expect(findForks([A, R])).toStrictEqual([
      { parent: undefined, previous: undefined, successors: [A, R] },
    ]);
  });

  it("orders forks by their first successor, not by whether a parent file exists", () => {
    expect(findForks([M1, M2, A, X, B])).toStrictEqual([
      { parent: A, previous: A.hash, successors: [B, X] },
      { parent: undefined, previous: GONE.hash, successors: [M1, M2] },
    ]);
  });

  it("orders forks with the same first sequence by filename", () => {
    expect(findForks([N1, N2, M1, M2])).toStrictEqual([
      { parent: undefined, previous: GONE.hash, successors: [M1, M2] },
      { parent: undefined, previous: GONE2.hash, successors: [N1, N2] },
    ]);
  });

  it("keeps the previous hash when no file holds the parent", () => {
    expect(findForks([B, X])).toStrictEqual([
      { parent: undefined, previous: A.hash, successors: [B, X] },
    ]);
  });
});
