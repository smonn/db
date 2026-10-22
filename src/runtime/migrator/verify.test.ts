import { describe, expect, it } from "vitest";
import type { MigrationFile, MigrationSource } from "../ports/index.ts";
import { migrationHash } from "./migration-file.ts";
import { verify } from "./verify.ts";

async function chain(...files: [filename: string, body: string][]): Promise<MigrationFile[]> {
  const result: MigrationFile[] = [];
  let previous: string | undefined;
  for (const [filename, body] of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each hash covers the one before it.
    const hash = await migrationHash(previous, body);
    result.push({
      filename,
      content: `--! Previous: ${previous ?? "-"}\n--! Hash: ${hash}\n\n${body}`,
    });
    previous = hash;
  }
  return result;
}

function source(files: readonly MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

function renamed(file: MigrationFile | undefined, filename: string): MigrationFile {
  if (file === undefined) throw new Error("no such file");
  return { ...file, filename };
}

const [A, B, C] = await chain(
  ["000001-a.sql", "create table a (n int);\n"],
  ["000002-b.sql", "create table b (n int);\n"],
  ["000003-c.sql", "create table c (n int);\n"],
);

describe("verify", () => {
  it("lists the files of an intact chain in sequence order", async () => {
    expect(await verify(source([C!, A!, B!]))).toStrictEqual({
      verified: ["000001-a.sql", "000002-b.sql", "000003-c.sql"],
    });
  });

  it("accepts an empty source", async () => {
    expect(await verify(source([]))).toStrictEqual({ verified: [] });
  });

  it("refuses a changed body, naming the file", async () => {
    const changed = { ...B!, content: B!.content.replace("table b", "table bb") };

    await expect(verify(source([A!, changed, C!]))).rejects.toThrow(
      /^000002-b\.sql: --! Hash says sha256:\w+ but the body hashes to sha256:\w+$/u,
    );
  });

  it("refuses a missing file, naming the file after the gap", async () => {
    await expect(verify(source([A!, C!]))).rejects.toThrow(
      "000003-c.sql: sequence 2 is missing before it",
    );
  });

  it("accepts a chain missing its last file, which only migrate can catch", async () => {
    expect(await verify(source([A!, B!]))).toStrictEqual({
      verified: ["000001-a.sql", "000002-b.sql"],
    });
  });

  it("refuses a repeated sequence, naming the second file", async () => {
    const [, other] = await chain(
      ["000001-a.sql", "create table a (n int);\n"],
      ["000002-other.sql", "create table other (n int);\n"],
    );

    await expect(verify(source([A!, B!, other!]))).rejects.toThrow(
      "000002-other.sql: repeats sequence 2",
    );
  });

  it("refuses a file inserted into the chain, naming the file it displaced", async () => {
    const [, inserted] = await chain(
      ["000001-a.sql", "create table a (n int);\n"],
      ["000002-inserted.sql", "create table inserted (n int);\n"],
    );

    await expect(
      verify(source([A!, inserted!, renamed(B, "000003-b.sql"), renamed(C, "000004-c.sql")])),
    ).rejects.toThrow(/^000003-b\.sql: --! Previous should be sha256:\w+, not sha256:\w+$/u);
  });

  it("refuses reordered files, naming the first one out of place", async () => {
    await expect(
      verify(source([A!, renamed(C, "000002-c.sql"), renamed(B, "000003-b.sql")])),
    ).rejects.toThrow(/^000002-c\.sql: --! Previous should be sha256:\w+, not sha256:\w+$/u);
  });
});
