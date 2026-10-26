import type { MigrationFile } from "../ports/index.ts";
import { sha256 } from "./sha256.ts";

/** A Committed migration's name, such as `000001-create-users.sql`, capturing its sequence. */
const COMMITTED_FILENAME: RegExp = /^(\d+)-[^/]+\.sql$/u;

/** The Current migration's name, beside the Committed migrations in the same folder. */
export const CURRENT_FILENAME = "current.sql";

export type ParsedMigration = {
  readonly filename: string;
  readonly sequence: number;
  /** `undefined` for the first file, whose header reads `--! Previous: -`. */
  readonly previous: string | undefined;
  readonly hash: string;
  /** The SQL below the headers, as it is hashed. */
  readonly body: string;
  /** Whether the file has the `--! no-transaction` header, so it runs outside a transaction (ADR-0020). */
  readonly noTransaction: boolean;
};

/** The header that makes a Committed migration run outside a transaction (ADR-0020). */
const NO_TRANSACTION = "--! no-transaction";

const HEADER = /^--! (Previous|Hash): (.*)$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

/** Parses ADR-0008's format. Throws, naming the file, on anything it can't read. */
export function parseMigration({ filename, content }: MigrationFile): ParsedMigration {
  const sequence = committedSequence(filename);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const { headers, noTransaction, line } = readHeaders(filename, lines);
  const previous = requiredHeader(filename, headers, "Previous");
  return {
    filename,
    sequence,
    previous: previous === "-" ? undefined : checkedHash(filename, "Previous", previous),
    hash: checkedHash(filename, "Hash", requiredHeader(filename, headers, "Hash")),
    body: normalizeBody(lines.slice(line).join("\n")),
    noTransaction,
  };
}

function readHeaders(
  filename: string,
  lines: readonly string[],
): { headers: Map<string, string>; noTransaction: boolean; line: number } {
  const headers = new Map<string, string>();
  let noTransaction = false;
  let line = 0;
  for (; line < lines.length && lines[line]?.startsWith("--!") === true; line++) {
    const header = lines[line] ?? "";
    if (header === NO_TRANSACTION) {
      checkNoTransaction(filename, headers, noTransaction);
      noTransaction = true;
    } else {
      addHeader(filename, headers, header);
    }
  }
  return { headers, noTransaction, line };
}

function checkNoTransaction(
  filename: string,
  headers: ReadonlyMap<string, string>,
  seen: boolean,
): void {
  if (seen) throw new Error(`${filename}: repeats the ${NO_TRANSACTION} header`);
  if (!headers.has("Hash")) {
    throw new Error(`${filename}: put ${NO_TRANSACTION} below --! Hash`);
  }
}

function addHeader(filename: string, headers: Map<string, string>, header: string): void {
  const match = HEADER.exec(header);
  if (match === null) throw new Error(`${filename}: unknown header ${header}`);
  const name = match[1] ?? "";
  if (headers.has(name)) throw new Error(`${filename}: repeats the --! ${name} header`);
  headers.set(name, match[2] ?? "");
}

export type HashOptions = {
  /** Whether the file has the `--! no-transaction` header, which the hash covers (ADR-0020). */
  readonly noTransaction?: boolean | undefined;
};

/**
 * ADR-0008's chain hash: the previous hash (empty for the first file), a newline, the
 * `--! no-transaction` header and a newline when the file has it (ADR-0020), and the body.
 */
export async function migrationHash(
  previous: string | undefined,
  body: string,
  { noTransaction = false }: HashOptions = {},
): Promise<string> {
  const header = noTransaction ? `${NO_TRANSACTION}\n` : "";
  return `sha256:${await sha256(`${previous ?? ""}\n${header}${body}`)}`;
}

export type WrittenMigration = MigrationFile & {
  /** The `--! Hash` header, which the next file names as its Previous. */
  readonly hash: string;
};

/** Writes a Committed migration whose headers chain `body` onto `previous`, the prior file's Hash. */
export async function writeMigration(
  filename: string,
  previous: string | undefined,
  body: string,
  options: HashOptions = {},
): Promise<WrittenMigration> {
  committedSequence(filename);
  const normalized = normalizeBody(body);
  const hash = await migrationHash(previous, normalized, options);
  const header = options.noTransaction === true ? `${NO_TRANSACTION}\n` : "";
  return {
    filename,
    content: `--! Previous: ${previous ?? "-"}\n--! Hash: ${hash}\n${header}\n${normalized}`,
    hash,
  };
}

/**
 * The names in a migrations folder that are Committed migrations: every `.sql` file but the
 * Current migration. A misnamed one is kept, so `parseMigration` refuses it by name.
 */
export function committedFilenames(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith(".sql") && name !== CURRENT_FILENAME);
}

export type CurrentMigration = {
  readonly body: string;
  readonly hash: string;
};

const GENERATED = /^--! Generated: (sha256:[0-9a-f]{64})$/u;

/** Writes the Current migration under a `--! Generated` header hashing its body (ADR-0003). */
export async function writeCurrent(sql: string): Promise<CurrentMigration & { content: string }> {
  const body = normalizeBody(sql);
  const hash = await currentHash(body);
  return { body, hash, content: `--! Generated: ${hash}\n\n${body}` };
}

export type ParsedCurrent = {
  /** The SQL below the `--! Generated` header, or the whole file when that header is gone. */
  readonly body: string;
  /** `true` when the header is gone or no longer matches the body. */
  readonly edited: boolean;
};

/** Parses `current.sql`, telling a file `generate` wrote from one edited by hand. */
export async function parseCurrent(content: string): Promise<ParsedCurrent> {
  const [header = "", ...rest] = content.replaceAll("\r\n", "\n").split("\n");
  const generated = GENERATED.exec(header)?.[1];
  if (generated === undefined) {
    return { body: normalizeBody([header, ...rest].join("\n")), edited: true };
  }
  const body = normalizeBody(rest.join("\n"));
  return { body, edited: generated !== (await currentHash(body)) };
}

/**
 * Splits the `--! no-transaction` header, a hand edit's first line, from a Current migration body.
 * The body keeps the header as a comment, so the Current migration's hash covers it, and `commit`
 * carries it into the Committed file (ADR-0020).
 */
export function splitCurrentHeader(body: string): { noTransaction: boolean; sql: string } {
  if (body.split("\n", 1)[0] !== NO_TRANSACTION) return { noTransaction: false, sql: body };
  return { noTransaction: true, sql: normalizeBody(body.slice(NO_TRANSACTION.length)) };
}

/** The hash `--! Generated` and the tracking schema's `current` table record for a Current migration body. */
export async function currentHash(body: string): Promise<string> {
  return `sha256:${await sha256(body)}`;
}

function committedSequence(filename: string): number {
  const sequence = COMMITTED_FILENAME.exec(filename)?.[1];
  if (sequence === undefined) {
    throw new Error(`${filename}: name it like 000001-create-users.sql`);
  }
  const number = Number(sequence);
  if (number < 1) throw new Error(`${filename}: sequences start at 1, not ${number}`);
  return number;
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
  return `${body.replaceAll("\r\n", "\n").trim()}\n`;
}
