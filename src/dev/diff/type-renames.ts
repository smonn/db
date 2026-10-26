import type { DomainRename, EnumRename, Fact, LabelRename } from "../catalog/index.ts";
import type { Action } from "./actions.ts";

/** The action for an enum, label, or domain rename, on the fact the `from` catalog holds. */
export function typeRenameAction(
  rename: EnumRename | LabelRename | DomainRename,
  fact: Fact,
): Action | undefined {
  if (rename.kind === "enum" && fact.kind === "enum") {
    return { kind: "rename enum", fact, rename };
  }
  if (rename.kind === "enum label" && fact.kind === "enum") {
    return { kind: "rename enum label", fact, rename };
  }
  if (rename.kind === "domain" && fact.kind === "domain") {
    return { kind: "rename domain", fact, rename };
  }
  return undefined;
}
