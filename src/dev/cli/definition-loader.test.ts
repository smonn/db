import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "../catalog/index.ts";
import { loadDefinitionInWorker } from "./definition-loader.ts";

const RUNTIME = JSON.stringify(join(import.meta.dirname, "../../runtime/index.ts"));

let dir: string;

beforeEach(async () => {
  // The resolve hook reports real paths, and macOS links the temp folder elsewhere.
  dir = await realpath(await mkdtemp(join(tmpdir(), "smonn-db-loader-")));
  await mkdir(join(dir, "tables"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(file: string, source: string): Promise<string> {
  const path = join(dir, file);
  await writeFile(path, source);
  return path;
}

function users(columns: string): string {
  return `import { defineTable } from ${RUNTIME};
export const users = defineTable((c) => ({ ${columns} }));
`;
}

function definition(tables: string): string {
  return `import { defineDatabase } from ${RUNTIME};
import { users } from "./tables/users.ts";
export default defineDatabase({ ${tables} });
`;
}

/** Appends to `ticks` every few milliseconds for as long as the Worker runs. */
function ticking(ticks: string): string {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(ticks)}, ".");
setInterval(() => appendFileSync(${JSON.stringify(ticks)}, "."), 2);
`;
}

/** The size of `ticks` now and a moment later, equal once the Worker has ended. */
async function ticksNowAndLater(ticks: string): Promise<[number, number]> {
  const now = (await stat(ticks)).size;
  await delay(50);
  return [now, (await stat(ticks)).size];
}

describe("loadDefinitionInWorker", () => {
  it("returns the Definition's Catalog, schema names, and module graph", async () => {
    await write("tables/users.ts", users("id: c.text().primaryKey()"));
    const file = await write("definition.ts", definition(`app: { users }`));

    const loaded = await loadDefinitionInWorker(file);

    const expected = defineDatabase({
      app: { users: defineTable((c) => ({ id: c.text().primaryKey() })) },
    });
    expect(loaded.catalog).toStrictEqual(definitionCatalog(expected));
    expect(loaded.schemas).toStrictEqual(["app"]);
    expect(loaded.files.filter((path) => path.startsWith(dir))).toStrictEqual([
      file,
      join(dir, "tables/users.ts"),
    ]);
  });

  it("sees a change to the Definition file and to a module it imports on the next call", async () => {
    await write("tables/users.ts", users("id: c.text().primaryKey()"));
    const file = await write("definition.ts", definition(`public: { users }`));
    await loadDefinitionInWorker(file);

    await write("tables/users.ts", users("id: c.text().primaryKey(), name: c.text()"));
    await write("definition.ts", definition(`app: { users }`));
    const loaded = await loadDefinitionInWorker(file);

    const expected = defineDatabase({
      app: { users: defineTable((c) => ({ id: c.text().primaryKey(), name: c.text() })) },
    });
    expect(loaded.catalog).toStrictEqual(definitionCatalog(expected));
    expect(loaded.schemas).toStrictEqual(["app"]);
  });

  it("leaves imports from node_modules out of the module graph", async () => {
    await mkdir(join(dir, "node_modules/helper"), { recursive: true });
    await write("node_modules/helper/package.json", `{ "name": "helper", "main": "index.js" }`);
    await write("node_modules/helper/index.js", "exports.schema = 'app';\n");
    const file = await write(
      "definition.ts",
      `import helper from "helper";\nexport default { [helper.schema]: {} };\n`,
    );

    const loaded = await loadDefinitionInWorker(file);

    expect(loaded.schemas).toStrictEqual(["app"]);
    expect(loaded.files).toStrictEqual([file]);
  });

  it("ends the Worker once it has the result, even with a timer left running", async () => {
    const ticks = join(dir, "ticks");
    const file = await write("definition.ts", `${ticking(ticks)}export default { public: {} };\n`);

    await loadDefinitionInWorker(file);

    const [now, later] = await ticksNowAndLater(ticks);
    expect(later).toBe(now);
  });

  it("rejects with the Definition file named when it throws, and ends the Worker", async () => {
    const ticks = join(dir, "ticks");
    const file = await write(
      "definition.ts",
      `${ticking(ticks)}await new Promise((resolve) => setTimeout(resolve, 10));\nthrow new Error("boom");\n`,
    );

    const loading = loadDefinitionInWorker(file);

    await expect(loading).rejects.toThrow(`${relative(process.cwd(), file)}: boom`);
    await expect(loading).rejects.toMatchObject({ cause: { message: "boom" } });
    const [now, later] = await ticksNowAndLater(ticks);
    expect(later).toBe(now);
  });

  it("names the Definition file when a module it imports throws", async () => {
    await write("tables/users.ts", `throw new Error("bad table");\nexport const users = {};\n`);
    const file = await write("definition.ts", definition(`public: { users }`));

    await expect(loadDefinitionInWorker(file)).rejects.toThrow(
      `${relative(process.cwd(), file)}: bad table`,
    );
  });

  it("refuses a default export that isn't a Definition", async () => {
    const file = await write("definition.ts", "export default null;\n");

    await expect(loadDefinitionInWorker(file)).rejects.toThrow(
      `${relative(process.cwd(), file)} must export defineDatabase({ ... }) as its default export`,
    );
  });

  it("rejects when the Worker exits without a result", async () => {
    const file = await write("definition.ts", "process.exit(3);\n");

    await expect(loadDefinitionInWorker(file)).rejects.toThrow(
      `The Worker loading ${relative(process.cwd(), file)} exited with code 3 before returning its Catalog`,
    );
  });
});
