import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { declaredRenames, definitionCatalog } from "../catalog/index.ts";
import { loadDefinitionInWorker, settledLoad } from "./definition-loader.ts";

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
  it("returns the Definition's Catalog, schema names, renames, and module graph", async () => {
    await write("tables/users.ts", users(`id: c.text().primaryKey().renamedFrom("key")`));
    const file = await write("definition.ts", definition(`app: { users }`));

    const loaded = await loadDefinitionInWorker(file);

    const expected = defineDatabase({
      app: { users: defineTable((c) => ({ id: c.text().primaryKey().renamedFrom("key") })) },
    });
    expect(loaded.catalog).toStrictEqual(definitionCatalog(expected));
    expect(loaded.schemas).toStrictEqual(["app"]);
    expect(loaded.renames).toStrictEqual(declaredRenames(expected));
    expect(loaded.renames).not.toHaveLength(0);
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

  it("names the module that throws, not the Definition file importing it", async () => {
    const table = await write(
      "tables/users.ts",
      `throw new Error("bad table");\nexport const users = {};\n`,
    );
    const file = await write("definition.ts", definition(`public: { users }`));

    await expect(loadDefinitionInWorker(file)).rejects.toThrow(
      `${relative(process.cwd(), table)}: bad table`,
    );
  });

  it("names the module that fails to parse", async () => {
    const table = await write("tables/users.ts", "export const users = ;\n");
    const file = await write("definition.ts", definition(`public: { users }`));

    await expect(loadDefinitionInWorker(file)).rejects.toThrow(
      `${relative(process.cwd(), table)}: Expression expected`,
    );
  });

  it("returns the Catalog when the Worker errors after posting it", async () => {
    // A timer the Definition left can throw before terminate() lands; a real Worker hits that
    // window too rarely to test, so a stand-in plays the events in that order.
    // oxlint-disable-next-line unicorn/prefer-event-target -- it stands in for a Worker, a Node EventEmitter.
    const worker = Object.assign(new EventEmitter(), { terminate: () => Promise.resolve(0) });
    const loaded = { catalog: new Map(), schemas: ["public"], renames: [], files: [] };

    const loading = settledLoad(worker, "definition.ts", {});
    worker.emit("message", loaded);
    worker.emit("error", new Error("late"));
    worker.emit("exit", 1);

    await expect(loading).resolves.toBe(loaded);
  });

  it("rejects and ends the Worker when the Definition doesn't settle in time", async () => {
    const ticks = join(dir, "ticks");
    const file = await write("definition.ts", `${ticking(ticks)}await new Promise(() => {});\n`);

    await expect(loadDefinitionInWorker(file, { timeoutMs: 100 })).rejects.toThrow(
      `${relative(process.cwd(), file)} didn't load within 100 ms`,
    );
    const [now, later] = await ticksNowAndLater(ticks);
    expect(later).toBe(now);
  });

  it("rejects and ends the Worker when the signal aborts", async () => {
    const ticks = join(dir, "ticks");
    const file = await write("definition.ts", `${ticking(ticks)}await new Promise(() => {});\n`);
    const controller = new AbortController();

    const loading = loadDefinitionInWorker(file, { signal: controller.signal });
    await vi.waitFor(async () => {
      expect((await stat(ticks)).size).toBeGreaterThan(0);
    });
    controller.abort(new Error("interrupted"));

    await expect(loading).rejects.toThrow(`stopped loading ${relative(process.cwd(), file)}`);
    await expect(loading).rejects.toMatchObject({ cause: { message: "interrupted" } });
    const [now, later] = await ticksNowAndLater(ticks);
    expect(later).toBe(now);
  });

  it("starts no Worker when the signal has already aborted", async () => {
    const ticks = join(dir, "ticks");
    const file = await write("definition.ts", `${ticking(ticks)}export default { public: {} };\n`);

    await expect(loadDefinitionInWorker(file, { signal: AbortSignal.abort() })).rejects.toThrow(
      `stopped loading ${relative(process.cwd(), file)}`,
    );
    await expect(stat(ticks)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the module graph it resolved when the load fails", async () => {
    await mkdir(join(dir, "new"));
    await write("new/table.ts", "export const users = ;\n");
    const file = await write(
      "definition.ts",
      `import { users } from "./new/table.ts";\nexport default { public: { users } };\n`,
    );

    await expect(loadDefinitionInWorker(file)).rejects.toMatchObject({
      files: [file, join(dir, "new/table.ts")],
    });
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
