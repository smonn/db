/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Shared by the probe623-*.mjs probes: runs one step and prints OK with its result or FAIL with the SQLSTATE and message.
export async function attempt(label, fn) {
  try {
    console.log(`  ${label}: OK`, JSON.stringify(await fn()));
  } catch (e) {
    console.log(`  ${label}: FAIL ${e.code ?? ""} ${e.message}`);
  }
}
