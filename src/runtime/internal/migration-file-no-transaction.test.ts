import { describe, expect, it } from "vitest";
import {
  migrationHash,
  parseMigration,
  splitCurrentHeader,
  writeMigration,
} from "./migration-file.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const BODY = "create index concurrently users_name on users (name);\n";

describe("parseMigration with a no-transaction header (ADR-0020)", () => {
  it("reads the header below Hash, leaving it out of the body", () => {
    const parsed = parseMigration({
      filename: "000001-a.sql",
      content: `--! Previous: -\n--! Hash: ${HASH_A}\n--! no-transaction\n\nselect 1;\n`,
    });

    expect(parsed).toMatchObject({ noTransaction: true, body: "select 1;\n" });
  });

  it.each([
    [
      "above Hash",
      `--! Previous: -\n--! no-transaction\n--! Hash: ${HASH_A}\n\nselect 1;\n`,
      "put --! no-transaction below --! Hash",
    ],
    [
      "twice",
      `--! Previous: -\n--! Hash: ${HASH_A}\n--! no-transaction\n--! no-transaction\n\nselect 1;\n`,
      "repeats the --! no-transaction header",
    ],
    [
      "with a value",
      `--! Previous: -\n--! Hash: ${HASH_A}\n--! no-transaction: yes\n\nselect 1;\n`,
      "unknown header --! no-transaction: yes",
    ],
  ])("refuses the header %s", (_, content, message) => {
    expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
      `000001-a.sql: ${message}`,
    );
  });
});

describe("migrationHash with a no-transaction header", () => {
  it("adds the header and a newline before the body when present", async () => {
    expect(await migrationHash(undefined, BODY, { noTransaction: true })).toBe(
      "sha256:42f1e1392f8716254b7d7bab74aaa57f23fee10a264bb2a9208abc0a08976861",
    );
    expect(await migrationHash(undefined, BODY, { noTransaction: false })).toBe(
      "sha256:82ae26c05c2e75d3eb2c05cb16c52cf4c50f656eeddba884568ba7632d4c9093",
    );
    expect(await migrationHash(undefined, BODY)).toBe(
      "sha256:82ae26c05c2e75d3eb2c05cb16c52cf4c50f656eeddba884568ba7632d4c9093",
    );
  });
});

describe("writeMigration with a no-transaction header", () => {
  it("writes the header below Hash, and the file parses back with its hash", async () => {
    const written = await writeMigration("000001-a.sql", undefined, BODY, { noTransaction: true });

    expect(written.content).toBe(
      `--! Previous: -\n--! Hash: ${written.hash}\n--! no-transaction\n\n${BODY}`,
    );
    expect(written.hash).toBe(
      "sha256:42f1e1392f8716254b7d7bab74aaa57f23fee10a264bb2a9208abc0a08976861",
    );
    expect(parseMigration(written)).toMatchObject({
      noTransaction: true,
      body: BODY,
      hash: written.hash,
    });
  });
});

describe("splitCurrentHeader", () => {
  it("reads a no-transaction header on the first line and returns the SQL below it", () => {
    expect(splitCurrentHeader(`--! no-transaction\n\n${BODY}`)).toStrictEqual({
      noTransaction: true,
      sql: BODY,
    });
  });

  it("returns the body as it is when there is no header", () => {
    expect(splitCurrentHeader("select 1;\n")).toStrictEqual({
      noTransaction: false,
      sql: "select 1;\n",
    });
  });

  it("ignores the header text further down, where it is only a comment", () => {
    expect(splitCurrentHeader("select 1;\n--! no-transaction\n")).toStrictEqual({
      noTransaction: false,
      sql: "select 1;\n--! no-transaction\n",
    });
  });
});
