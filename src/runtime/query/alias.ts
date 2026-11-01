/** Postgres truncates a longer identifier, so `<63-byte name>_2` would read back as the name. */
const MAX_ALIAS_BYTES = 63;

const encoder = new TextEncoder();

/** `name`'s longest prefix of whole characters that fits in `bytes` UTF-8 bytes. */
function cut(name: string, bytes: number): string {
  let prefix = "";
  let size = 0;
  for (const character of name) {
    size += encoder.encode(character).length;
    if (size > bytes) break;
    prefix += character;
  }
  return prefix;
}

/**
 * A joined table's alias: its SQL name, or on a repeat the first of `_2`, `_3`, and so on that no
 * earlier table uses, with the name cut so name plus suffix fits in 63 bytes.
 */
export function aliasFor(name: string, used: ReadonlySet<string>): string {
  let alias = name;
  for (let n = 2; used.has(alias); n += 1) {
    const suffix = `_${n}`;
    alias = `${cut(name, MAX_ALIAS_BYTES - suffix.length)}${suffix}`;
  }
  return alias;
}
