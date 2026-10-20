// PROTOTYPE, throwaway. Loads each variant's Definition the way the CLI
// would, prints the catalog the diff would receive, and checks that all
// three variants describe the same Database.

import { collectTables as collectA } from "./a-flat-tables/db.ts";
import * as a from "./a-flat-tables/definition.ts";
import { tablesOf } from "./b-database-object/db.ts";
import b from "./b-database-object/definition.ts";
import { collectTables as collectC } from "./c-column-callback/db.ts";
import * as c from "./c-column-callback/definition.ts";
import { toCatalog } from "./core.ts";
import d from "./d-hybrid/db.ts";
import * as D from "./d-hybrid/lib.ts";

const catalogs = {
  "D hybrid": D.toCatalog(D.tablesOf(d)),
  "A flat tables": toCatalog(collectA(a)),
  "B database object": toCatalog(tablesOf(b)),
  "C column callback": toCatalog(collectC(c)),
};

const [first, ...rest] = Object.values(catalogs);
console.log(JSON.stringify(first, null, 2));
for (const [name, catalog] of Object.entries(catalogs)) {
  const same = JSON.stringify(catalog) === JSON.stringify(first);
  console.log(`${name}: ${same ? "same catalog" : "DIFFERENT catalog"}`);
}
if (rest.some((catalog) => JSON.stringify(catalog) !== JSON.stringify(first))) process.exitCode = 1;
