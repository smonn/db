// toISOString writes BC and five-digit years as `-000043` and `+010000`, which Postgres refuses.
// The text names a UTC instant, and a timestamp column ignores the `+00`.
export function formatTimestamp(value: Date): string {
  const iso = value.toISOString();
  const time = iso.indexOf("T");
  const year = value.getUTCFullYear();
  const era = year > 0 ? "" : " BC";
  return `${String(year > 0 ? year : 1 - year).padStart(4, "0")}${iso.slice(time - 6, time)} ${iso.slice(time + 1, -1)}+00${era}`;
}
