import { describe, expect, it } from "vitest";
import { writeMigration } from "../internal/index.ts";
import type { MigrationFile, MigrationSource } from "../ports/index.ts";
import { verify } from "./verify.ts";

function source(files: readonly MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

function renamed(file: MigrationFile, filename: string): MigrationFile {
  return { ...file, filename };
}

const A = await writeMigration("000001-a.sql", undefined, "create table a (n int);\n");
const B = await writeMigration("000002-b.sql", A.hash, "create table b (n int);\n");
const C = await writeMigration("000003-c.sql", B.hash, "create table c (n int);\n");

describe("verify", () => {
  it("lists the files of an intact chain in sequence order", async () => {
    expect(await verify(source([C, A, B]))).toStrictEqual({
      verified: ["000001-a.sql", "000002-b.sql", "000003-c.sql"],
    });
  });

  it("accepts an empty source", async () => {
    expect(await verify(source([]))).toStrictEqual({ verified: [] });
  });

  it("refuses a changed body, naming the file", async () => {
    const changed = { ...B, content: B.content.replace("table b", "table bb") };

    await expect(verify(source([A, changed, C]))).rejects.toThrow(
      /^000002-b\.sql: --! Hash says sha256:\w+ but the body hashes to sha256:\w+$/u,
    );
  });

  it("refuses a bogus Hash header above a valid one", async () => {
    const doubled = {
      ...A,
      content: A.content.replace("--! Hash:", `--! Hash: sha256:${"0".repeat(64)}\n--! Hash:`),
    };

    await expect(verify(source([doubled, B, C]))).rejects.toThrow(
      "000001-a.sql: repeats the --! Hash header",
    );
  });

  it("refuses a missing file, naming the file after the gap", async () => {
    await expect(verify(source([A, C]))).rejects.toThrow(
      "000003-c.sql: sequence 2 is missing before it",
    );
  });

  it("accepts a chain missing its last file, which only migrate can catch", async () => {
    expect(await verify(source([A, B]))).toStrictEqual({
      verified: ["000001-a.sql", "000002-b.sql"],
    });
  });

  it("refuses a repeated sequence, naming the second file", async () => {
    await expect(verify(source([A, B, renamed(C, "000002-c.sql")]))).rejects.toThrow(
      "000002-c.sql: repeats sequence 2",
    );
  });

  it("names a fork: both files and the parent they share", async () => {
    const other = await writeMigration("000002-other.sql", A.hash, "create table other (n int);\n");

    await expect(verify(source([A, other, B]))).rejects.toThrow(
      "forked chain: 000002-b.sql and 000002-other.sql both follow 000001-a.sql",
    );
  });

  it("names every file of a three-way fork", async () => {
    const x = await writeMigration("000002-x.sql", A.hash, "create table x (n int);\n");
    const y = await writeMigration("000002-y.sql", A.hash, "create table y (n int);\n");

    await expect(verify(source([y, A, x, B]))).rejects.toThrow(
      "forked chain: 000002-b.sql, 000002-x.sql and 000002-y.sql all follow 000001-a.sql",
    );
  });

  it("names a fork whose branches have grown past the shared parent", async () => {
    const x = await writeMigration("000002-x.sql", A.hash, "create table x (n int);\n");
    const x3 = await writeMigration("000003-x3.sql", x.hash, "create table x3 (n int);\n");

    await expect(verify(source([A, B, C, x, x3]))).rejects.toThrow(
      "forked chain: 000002-b.sql and 000002-x.sql both follow 000001-a.sql",
    );
  });

  it("names a fork at the start of the chain", async () => {
    const root = await writeMigration("000001-root.sql", undefined, "create table r (n int);\n");

    await expect(verify(source([A, root]))).rejects.toThrow(
      "forked chain: 000001-a.sql and 000001-root.sql both start the chain",
    );
  });

  it("names the parent's hash when no file holds it", async () => {
    const other = await writeMigration("000002-other.sql", A.hash, "create table other (n int);\n");

    await expect(verify(source([B, other]))).rejects.toThrow(
      `forked chain: 000002-b.sql and 000002-other.sql both follow ${A.hash}`,
    );
  });

  it("names the fork nearest the start when several exist", async () => {
    const gone = await writeMigration("000004-gone.sql", A.hash, "create table gone (n int);\n");
    const m1 = await writeMigration("000005-m1.sql", gone.hash, "create table m1 (n int);\n");
    const m2 = await writeMigration("000005-m2.sql", gone.hash, "create table m2 (n int);\n");
    const other = await writeMigration("000002-other.sql", A.hash, "create table other (n int);\n");

    await expect(verify(source([m1, m2, A, other, B]))).rejects.toThrow(
      "forked chain: 000002-b.sql and 000002-other.sql both follow 000001-a.sql",
    );
  });

  it("refuses a file numbered 0, saying sequences start at 1", async () => {
    await expect(verify(source([renamed(A, "000000-zero.sql"), B]))).rejects.toThrow(
      "000000-zero.sql: sequences start at 1, not 0",
    );
  });

  it("refuses a file inserted into the chain, naming it and the file it displaced", async () => {
    const inserted = await writeMigration(
      "000002-inserted.sql",
      A.hash,
      "create table inserted (n int);\n",
    );

    await expect(
      verify(source([A, inserted, renamed(B, "000003-b.sql"), renamed(C, "000004-c.sql")])),
    ).rejects.toThrow(
      "forked chain: 000002-inserted.sql and 000003-b.sql both follow 000001-a.sql",
    );
  });

  it("refuses reordered files, naming the first one out of place", async () => {
    await expect(
      verify(source([A, renamed(C, "000002-c.sql"), renamed(B, "000003-b.sql")])),
    ).rejects.toThrow(/^000002-c\.sql: --! Previous should be sha256:\w+, not sha256:\w+$/u);
  });
});
