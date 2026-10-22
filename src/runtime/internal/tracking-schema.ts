export const DEFAULT_TRACKING_SCHEMA = "smonn_db";

const MAX_IDENTIFIER_BYTES = 63;

/** Validates a tracking schema name and quotes it as an identifier. */
export function quoteTrackingSchema(name: string): string {
  if (name === "") {
    throw new Error("trackingSchema must not be empty");
  }
  if (name.includes("\0")) {
    throw new Error("trackingSchema must not contain a NUL byte");
  }
  if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`trackingSchema must be at most ${MAX_IDENTIFIER_BYTES} bytes in UTF-8`);
  }
  if (name.startsWith("pg_")) {
    throw new Error('trackingSchema must not start with "pg_", which Postgres reserves');
  }
  return `"${name.replaceAll('"', '""')}"`;
}
