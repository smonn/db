import type { Catalog } from "../catalog/index.ts";
import { diff } from "./diff.ts";

/**
 * The diff's SQL without its `-- hazard:` comments, for tests of the statements themselves.
 * `hazard-comments.test.ts` covers the comments.
 */
export function bareDiff(from: Catalog, to: Catalog): string {
  return diff(from, to).sql.replaceAll(/^-- hazard: \w+\n/gmu, "");
}
