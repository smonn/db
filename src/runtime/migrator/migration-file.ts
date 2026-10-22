import type { MigrationFile } from "../ports/index.ts";
import { COMMITTED_FILENAME } from "../internal/index.ts";

export type ParsedMigration = {
  readonly filename: string;
  readonly sequence: number;
  /** `undefined` for the first file, whose header reads `--! Previous: -`. */
  readonly previous: string | undefined;
  readonly hash: string;
  /** The SQL below the headers, as it is hashed. */
  readonly body: string;
};

const HEADER = /^--! (Previous|Hash): (.*)$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

/** Parses ADR-0008's format. Throws, naming the file, on anything it can't read. */
export function parseMigration({ filename, content }: MigrationFile): ParsedMigration {
  const sequence = COMMITTED_FILENAME.exec(filename)?.[1];
  if (sequence === undefined) {
    throw new Error(`${filename}: name it like 000001-create-users.sql`);
  }

  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const headers = new Map<string, string>();
  let line = 0;
  for (; line < lines.length && lines[line]?.startsWith("--!") === true; line++) {
    const header = lines[line] ?? "";
    const match = HEADER.exec(header);
    if (match === null) throw new Error(`${filename}: unknown header ${header}`);
    headers.set(match[1] ?? "", match[2] ?? "");
  }

  const previous = requiredHeader(filename, headers, "Previous");
  return {
    filename,
    sequence: Number(sequence),
    previous: previous === "-" ? undefined : checkedHash(filename, "Previous", previous),
    hash: checkedHash(filename, "Hash", requiredHeader(filename, headers, "Hash")),
    body: normalizeBody(lines.slice(line).join("\n")),
  };
}

function requiredHeader(
  filename: string,
  headers: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = headers.get(name);
  if (value === undefined) throw new Error(`${filename}: missing the --! ${name} header`);
  return value;
}

function checkedHash(filename: string, name: string, value: string): string {
  if (!HASH.test(value)) {
    throw new Error(
      `${filename}: --! ${name} must be sha256: and 64 lowercase hex digits, not ${value}`,
    );
  }
  return value;
}

function normalizeBody(body: string): string {
  return `${body.trim()}\n`;
}
