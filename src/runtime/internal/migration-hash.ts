import { sha256 } from "./sha256.ts";

export async function migrationHash(previous: string | undefined, body: string): Promise<string> {
  return `sha256:${await sha256(`${previous ?? ""}\n${body}`)}`;
}
