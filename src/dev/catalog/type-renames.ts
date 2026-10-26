import { isDomain, isEnum, type Enum } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { factAt } from "./catalog.ts";
import type { DefinitionTables } from "./definition-catalog.ts";
import type { Catalog } from "./fact.ts";
import { applies } from "./rename-applies.ts";
import type { DomainRename, EnumRename, LabelRename } from "./rename-types.ts";

export type TypeRenames = {
  readonly enums: EnumRename[];
  readonly labels: LabelRename[];
  readonly domains: DomainRename[];
};

/** Every `renamedFrom` and `renamedLabels` marker on an enum or domain in the Definition. */
export function declaredTypeRenames(definition: DefinitionTables): TypeRenames {
  const renames: TypeRenames = { enums: [], labels: [], domains: [] };
  for (const [schema, entries] of Object.entries(definition)) {
    for (const [name, def] of Object.entries(entries)) {
      if (isDomain(def) && def.renamedFrom !== undefined) {
        renames.domains.push({ kind: "domain", schema, name, was: def.renamedFrom });
      } else if (isEnum(def)) {
        if (def.renamedFrom !== undefined) {
          renames.enums.push({ kind: "enum", schema, name, was: def.renamedFrom });
        }
        renames.labels.push(...labelRenames(schema, name, def));
      }
    }
  }
  return renames;
}

function labelRenames(schema: string, name: string, def: Enum): LabelRename[] {
  const olds = new Set<string>();
  return Object.entries(def.renamedLabels).map(([label, was]) => {
    if (!def.labels.includes(label)) {
      throw new Error(
        `enum ${quotedPath(schema, name)} has renamedLabels for ${JSON.stringify(label)}, which it doesn't list`,
      );
    }
    if (olds.has(was)) {
      throw new Error(
        `enum ${quotedPath(schema, name)} renames the label ${JSON.stringify(was)} to more than one label`,
      );
    }
    olds.add(was);
    return { kind: "enum label", schema, enum: name, name: label, was };
  });
}

/** The enum and domain renames that apply to `shadow`, and the label renames inside enums. */
export function appliedTypeRenames(declared: TypeRenames, shadow: Catalog): TypeRenames {
  const enums = declared.enums.filter((rename) =>
    applies(shadow, "enum", [rename.schema, rename.name], rename.was),
  );
  // A label sits in the enum under its old name until the enum's own `RENAME` runs.
  const was = new Map(enums.map((rename) => [`${rename.schema}\0${rename.name}`, rename.was]));
  const labels = declared.labels.filter((rename) =>
    labelApplies(
      shadow,
      rename,
      was.get(`${rename.schema}\0${rename.enum}`) ?? rename.enum,
      declared.labels,
    ),
  );
  const domains = declared.domains.filter((rename) =>
    applies(shadow, "domain", [rename.schema, rename.name], rename.was),
  );
  return { enums, labels, domains };
}

function labelApplies(
  shadow: Catalog,
  rename: LabelRename,
  enumName: string,
  siblings: readonly LabelRename[],
): boolean {
  const type = factAt(shadow, rename.schema, enumName);
  if (type?.kind !== "enum") return false;
  const { labels } = type.payload;
  const hasOld = labels.includes(rename.was);
  if (hasOld && chainsOrSwaps(rename, siblings)) {
    throw new Error(
      `enum ${quotedPath(rename.schema, enumName)} chains or swaps the label ${JSON.stringify(rename.name)} ` +
        "(it is both a new and an old label); split label chains and swaps across migrations",
    );
  }
  if (hasOld && labels.includes(rename.name)) {
    throw new Error(
      `enum ${quotedPath(rename.schema, enumName)} has renamedLabels ${JSON.stringify(rename.name)} from ` +
        `${JSON.stringify(rename.was)}, but the Shadow database holds both labels; ` +
        "drop the label you no longer want, or remove the entry",
    );
  }
  return hasOld;
}

function chainsOrSwaps(rename: LabelRename, siblings: readonly LabelRename[]): boolean {
  return siblings.some(
    (other) =>
      other.schema === rename.schema && other.enum === rename.enum && other.was === rename.name,
  );
}

function quotedPath(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}
