import { hazardsOf, render, type Action, type Catalogs } from "./actions.ts";
import type { Hazard } from "./hazards.ts";
import { order } from "./phases.ts";

export type Diff = {
  /** Each statement follows one `-- hazard: <kind>` comment per Hazard it carries. */
  readonly sql: string;
  readonly hazards: readonly Hazard[];
  /** Renames the Definition could declare, for a drop and an add that look like one (ADR-0024). */
  readonly hints: readonly string[];
};

/** Orders the actions and renders each, with the Hazards it carries. */
export function emit(actions: readonly Action[], catalogs: Catalogs): Omit<Diff, "hints"> {
  const hazards: Hazard[] = [];
  const sql = order(actions)
    .map((action) => {
      const statement = render(action, catalogs);
      const kinds = hazardsOf(action, catalogs);
      hazards.push(...kinds.map((kind) => ({ kind, statement })));
      return `${kinds.map((kind) => `-- hazard: ${kind}\n`).join("")}${statement}\n`;
    })
    .join("\n");
  return { sql, hazards };
}
