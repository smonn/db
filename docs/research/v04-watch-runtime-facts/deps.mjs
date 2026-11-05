/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// The resolve hook that versions imports also sees every resolved file: a free dependency list to watch.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "deps-"));
mkdirSync(join(dir, "tables"));
writeFileSync(join(dir, "tables", "users.ts"), `export const users = { v: 1 };\n`);
writeFileSync(
  join(dir, "shared.ts"),
  `import type { } from "node:fs";\nexport const shared = 1;\n`,
);
writeFileSync(
  join(dir, "definition.ts"),
  `import { users } from "./tables/users.ts";\nimport { shared } from "./shared.ts";\nimport { readFileSync } from "node:fs";\nexport default { users, shared, read: typeof readFileSync };\n`,
);

const seen = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith("file:") && !resolved.url.includes("/node_modules/"))
      seen.add(fileURLToPath(resolved.url));
    return resolved;
  },
});
await import(pathToFileURL(join(dir, "definition.ts")).href);
console.log(
  process.version,
  "files the hook saw:",
  [...seen]
    .map((f) => f.slice(dir.length + 1))
    .sort()
    .join(", "),
);
rmSync(dir, { recursive: true, force: true });
