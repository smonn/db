/* oxlint-disable -- throwaway research probe, run by hand, not part of the build. */
// Registers a synchronous resolve hook that appends ?v=<generation()> to every project file URL, so each reload
// gets fresh module instances for the entry and all its imports. node_modules and node: builtins are left alone.
import { registerHooks } from "node:module";

export function versionProjectImports(generation) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("file:") && !resolved.url.includes("/node_modules/")) {
        const url = new URL(resolved.url);
        url.searchParams.set("v", String(generation()));
        return { ...resolved, url: url.href };
      }
      return resolved;
    },
  });
}
