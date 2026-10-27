import { describe, expect, it } from "vitest";
import {
  committedFilenames,
  migrationHash,
  parseCurrent,
  parseMigration,
  writeCurrent,
  writeMigration,
} from "./migration-file.ts";

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
      noTransaction: false,
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

  it("refuses a sequence of 0, saying sequences start at 1", () => {
    expect(() =>
      parseMigration({
        filename: "000000-a.sql",
        content: `--! Previous: -\n--! Hash: ${HASH_A}\nselect 1;`,
      }),
    ).toThrow("000000-a.sql: sequences start at 1, not 0");
  });

  it("refuses a missing header", () => {
    expect(() =>
      parseMigration({ filename: "000001-a.sql", content: "--! Previous: -\nselect 1;" }),
    ).toThrow("000001-a.sql: missing the --! Hash header");
  });

  it("refuses an unknown header", () => {
    const content = `--! Previous: -\n--! Hash: ${HASH_A}\n--! other\nselect 1;`;
    expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
      "000001-a.sql: unknown header --! other",
    );
  });

  it("refuses a repeated header, even with the same value", () => {
    const content = `--! Previous: -\n--! Previous: -\n--! Hash: ${HASH_A}\nselect 1;`;

    expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
      "000001-a.sql: repeats the --! Previous header",
    );
  });

  it("refuses a bogus Hash followed by a valid one", async () => {
    const hash = await migrationHash(undefined, "select 1;\n");
    const content = `--! Previous: -\n--! Hash: ${HASH_B}\n--! Hash: ${hash}\n\nselect 1;\n`;

    expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
      "000001-a.sql: repeats the --! Hash header",
    );
  });

  it("refuses a malformed hash", () => {
    expect(() =>
      parseMigration({ filename: "000001-a.sql", content: "--! Previous: -\n--! Hash: abc\n" }),
    ).toThrow("000001-a.sql: --! Hash must be sha256: and 64 lowercase hex digits, not abc");
  });

  it("refuses a malformed Previous hash, naming the header", () => {
    expect(() =>
      parseMigration({
        filename: "000002-a.sql",
        content: `--! Previous: abc\n--! Hash: ${HASH_A}\n`,
      }),
    ).toThrow("000002-a.sql: --! Previous must be sha256: and 64 lowercase hex digits, not abc");
  });

  it.each([`${HASH_A}0`, `x${HASH_A}`, HASH_A.toUpperCase()])("refuses %s as a hash", (hash) => {
    expect(() =>
      parseMigration({
        filename: "000001-a.sql",
        content: `--! Previous: -\n--! Hash: ${hash}\n`,
      }),
    ).toThrow(`not ${hash}`);
  });

  it.each(["x000001-a.sql", "dir/000001-a.sql", "000001-a.sql.bak", "000001-a.sqlx"])(
    "refuses the filename %s",
    (filename) => {
      expect(() =>
        parseMigration({ filename, content: `--! Previous: -\n--! Hash: ${HASH_A}\n` }),
      ).toThrow(`${filename}: name it like 000001-create-users.sql`);
    },
  );

  it.each([`--!x --! Hash: ${HASH_A}`, `--! Hash: ${HASH_A}\rmore`, `--! Hash: ${HASH_A} `])(
    "refuses the header line %j as an unknown header",
    (line) => {
      const content = `--! Previous: -\n${line}\nselect 1;`;
      expect(() => parseMigration({ filename: "000001-a.sql", content })).toThrow(
        `000001-a.sql: unknown header ${line}`,
      );
    },
  );

  it("reads a file with headers and no body", () => {
    const parsed = parseMigration({
      filename: "000001-a.sql",
      content: `--! Previous: -\n--! Hash: ${HASH_A}`,
    });
    expect(parsed).toMatchObject({ hash: HASH_A, body: "\n" });
  });
});

describe("migrationHash", () => {
  it("hashes a newline and the body when there is no previous file", async () => {
    expect(await migrationHash(undefined, "create table a (n int);\n")).toBe(
      "sha256:d7d725aa0112fb1cbd6f88755f17784646fcd5154e0ea687f488c87fa1499173",
    );
  });

  it("hashes the previous hash, a newline, and the body", async () => {
    expect(await migrationHash(`sha256:${"a".repeat(64)}`, "create table b (n int);\n")).toBe(
      "sha256:da769c6fe78ea3f7868d6e624c7e405f7f1035605c4d54d2f9057a81f2e07764",
    );
  });
});

describe("writeMigration", () => {
  it("writes a first file that parses back to its body and hash", async () => {
    const written = await writeMigration("000001-a.sql", undefined, "create table a (n int);\n");

    expect(written.content).toBe(
      `--! Previous: -\n--! Hash: ${written.hash}\n\ncreate table a (n int);\n`,
    );
    expect(parseMigration(written)).toStrictEqual({
      filename: "000001-a.sql",
      sequence: 1,
      previous: undefined,
      hash: "sha256:d7d725aa0112fb1cbd6f88755f17784646fcd5154e0ea687f488c87fa1499173",
      body: "create table a (n int);\n",
      noTransaction: false,
    });
  });

  it("chains a later file onto the previous Hash", async () => {
    const written = await writeMigration("000002-b.sql", HASH_A, "create table b (n int);\n");

    expect(parseMigration(written)).toMatchObject({
      sequence: 2,
      previous: HASH_A,
      hash: "sha256:da769c6fe78ea3f7868d6e624c7e405f7f1035605c4d54d2f9057a81f2e07764",
    });
  });

  it("normalises the body before hashing, as parseMigration reads it", async () => {
    const written = await writeMigration("000001-a.sql", undefined, "\r\n  select 1;\r\n\r\n");

    expect(parseMigration(written).body).toBe("select 1;\n");
    expect(written.hash).toBe(await migrationHash(undefined, "select 1;\n"));
  });

  it("turns CRLF inside the body into LF, so the file it writes parses to the same hash", async () => {
    const written = await writeMigration("000001-a.sql", undefined, "select 1;\r\nselect 2;\r\n");
    const parsed = parseMigration(written);

    expect(parsed.body).toBe("select 1;\nselect 2;\n");
    expect(await migrationHash(parsed.previous, parsed.body)).toBe(written.hash);
  });

  it("refuses a filename without a sequence and slug", async () => {
    await expect(writeMigration("create-a.sql", undefined, "select 1;\n")).rejects.toThrow(
      "create-a.sql: name it like 000001-create-users.sql",
    );
  });

  it("refuses a sequence of 0, saying sequences start at 1", async () => {
    await expect(writeMigration("000000-a.sql", undefined, "select 1;\n")).rejects.toThrow(
      "000000-a.sql: sequences start at 1, not 0",
    );
  });
});

describe("committedFilenames", () => {
  it("keeps every .sql name but current.sql, misnamed ones included", () => {
    expect(
      committedFilenames(["000001-a.sql", "current.sql", "create-b.sql", "README.md", "a.sql.bak"]),
    ).toStrictEqual(["000001-a.sql", "create-b.sql"]);
  });
});

describe("writeCurrent", () => {
  it("writes the body under a Generated header with the body's SHA-256", async () => {
    const hash = "sha256:a4761ea34262cc0f4cace3d40017a45aababa033d240fe51dd2ecf692f22929d";

    expect(await writeCurrent("create table a (n int);\n")).toStrictEqual({
      body: "create table a (n int);\n",
      hash,
      content: `--! Generated: ${hash}\n\ncreate table a (n int);\n`,
    });
  });

  it("normalises the body before hashing, as parseCurrent reads it", async () => {
    const written = await writeCurrent("\n  select 1;\r\n\n");

    expect(written.body).toBe("select 1;\n");
    expect(await parseCurrent(written.content)).toStrictEqual({
      body: "select 1;\n",
      edited: false,
    });
  });

  it("turns CRLF inside the body into LF, so the file it writes parses as unedited", async () => {
    const written = await writeCurrent("select 1;\r\nselect 2;\r\n");

    expect(written.body).toBe("select 1;\nselect 2;\n");
    expect(await parseCurrent(written.content)).toStrictEqual({
      body: "select 1;\nselect 2;\n",
      edited: false,
    });
  });
});

describe("parseCurrent", () => {
  it("reads a file generate wrote, CRLF or not", async () => {
    const { content } = await writeCurrent("select 1;\n");

    expect(await parseCurrent(content.replaceAll("\n", "\r\n"))).toStrictEqual({
      body: "select 1;\n",
      edited: false,
    });
  });

  it("marks a body that no longer matches its header as edited", async () => {
    const { content } = await writeCurrent("select 1;\n");

    expect(await parseCurrent(content.replace("select 1", "select 2"))).toStrictEqual({
      body: "select 2;\n",
      edited: true,
    });
  });

  it("marks a file without a Generated header as edited, keeping its first line", async () => {
    expect(await parseCurrent("select 1;\nselect 2;\n")).toStrictEqual({
      body: "select 1;\nselect 2;\n",
      edited: true,
    });
  });

  it("reads a Generated header alone as an empty body", async () => {
    const { hash } = await writeCurrent("\n");

    expect(await parseCurrent(`--! Generated: ${hash}`)).toStrictEqual({
      body: "\n",
      edited: false,
    });
  });

  it.each([
    (hash: string) => `x--! Generated: ${hash}`,
    (hash: string) => `--! Generated: ${hash}0`,
  ])("marks a header that only resembles Generated as edited", async (make) => {
    const { hash } = await writeCurrent("select 1;\n");
    const content = `${make(hash)}\n\nselect 1;\n`;

    expect(await parseCurrent(content)).toStrictEqual({
      body: `${make(hash)}\n\nselect 1;\n`,
      edited: true,
    });
  });
});
