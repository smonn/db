import { describe, expect, it } from "vitest";
import { parseMigration } from "./migration-file.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("parseMigration", () => {
  it("reads the sequence, headers, and body of a first file", () => {
    const parsed = parseMigration({
      filename: "000001-create-a.sql",
      content: `--! Previous: -\n--! Hash: ${HASH_A}\n\ncreate table a (n int);\n`,
    });
    expect(parsed).toStrictEqual({
      filename: "000001-create-a.sql",
      sequence: 1,
      previous: undefined,
      hash: HASH_A,
      body: "create table a (n int);\n",
    });
  });

  it("reads the Previous hash of a later file", () => {
    const parsed = parseMigration({
      filename: "000002-create-b.sql",
      content: `--! Previous: ${HASH_A}\n--! Hash: ${HASH_B}\ncreate table b (n int);`,
    });
    expect(parsed.sequence).toBe(2);
    expect(parsed.previous).toBe(HASH_A);
  });

  it("turns CRLF into LF and trims the body to one trailing newline", () => {
    const parsed = parseMigration({
      filename: "000001-a.sql",
      content: `--! Previous: -\r\n--! Hash: ${HASH_A}\r\n\r\n  select 1;\r\nselect 2;\r\n\r\n`,
    });
    expect(parsed.body).toBe("select 1;\nselect 2;\n");
  });

  it("refuses a filename without a sequence and slug", () => {
    expect(() =>
      parseMigration({ filename: "create-a.sql", content: `--! Previous: -\n--! Hash: ${HASH_A}` }),
    ).toThrow("create-a.sql: name it like 000001-create-users.sql");
  });

  it("refuses a missing header", () => {
    expect(() =>
      parseMigration({ filename: "000001-a.sql", content: "--! Previous: -\nselect 1;" }),
    ).toThrow("000001-a.sql: missing the --! Hash header");
  });

  it("refuses an unknown header", () => {
    const content = `--! Previous: -\n--! Hash: ${HASH_A}\n--! no-transaction\nselect 1;`;
    expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
      "000001-a.sql: unknown header --! no-transaction",
    );
  });

  it("refuses a malformed hash", () => {
    expect(() =>
      parseMigration({ filename: "000001-a.sql", content: "--! Previous: -\n--! Hash: abc\n" }),
    ).toThrow("000001-a.sql: --! Hash must be sha256: and 64 lowercase hex digits, not abc");
  });
});
