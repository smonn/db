import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const db = useTestDatabase();
const project = useCliProject();
const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;
const definitionUrl = pathToFileURL(
  join(import.meta.dirname, "../../runtime/definition/index.ts"),
).href;

const DROP_EMAIL = 'alter table "public"."users" drop column "email";';

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

/** A project whose Committed migration creates users with an email, and whose Definition has none. */
async function projectWithEmail(): Promise<string> {
  const created = await writeMigration(
    "000001-create-users.sql",
    undefined,
    "create table public.users (id text, email text);\n",
  );
  await mkdir(join(project.dir, "migrations"));
  await writeFile(join(project.dir, "migrations", created.filename), created.content);
  await writeFile(
    join(project.dir, "definition.ts"),
    `import { defineDatabase, defineTable } from "${definitionUrl}";\n\nexport default defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });\n`,
  );
  const config = join(project.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(db.url)} });\n`,
  );
  return config;
}

it("exits 1 when the Dev database can't catch up, after printing the file and its Hazards once", async () => {
  const config = await projectWithEmail();
  expect(await main(["reset", "--config", config])).toBe(0);
  await db.driver.execute("create view public.emails as select email from public.users");

  const first = await main(["generate", "--config", config]);

  expect(first).toBe(1);
  expect(project.stdout).toMatch(/^wrote .*current\.sql$/mu);
  expect(project.stdout).toContain(`hazard data_loss: ${DROP_EMAIL}`);
  expect(project.stdout.slice(project.stdout.indexOf("wrote "))).not.toContain("Dev database");
  expect(project.stderr).toMatch(
    /^the Dev database didn't catch up, so it was left as it was: .+; run smonndb reset to rebuild it from the files\n$/su,
  );

  const second = await main(["generate", "--config", config]);

  expect(second).toBe(1);
  expect(project.stdout.split(`hazard data_loss: ${DROP_EMAIL}`)).toHaveLength(2);
});

it("prints a catch_up_failed document with the file and its Hazards under --json", async () => {
  const config = await projectWithEmail();
  expect(await main(["reset", "--config", config])).toBe(0);
  await db.driver.execute("create view public.emails as select email from public.users");
  const stdout = project.stdout.length;

  const code = await main(["generate", "--json", "--config", config]);

  expect(code).toBe(1);
  const printed = project.stdout.slice(stdout);
  expect(printed.trimEnd()).not.toContain("\n");
  expect(JSON.parse(printed)).toStrictEqual({
    command: "generate",
    ok: false,
    error: {
      code: "catch_up_failed",
      message: expect.stringMatching(
        /^the Dev database didn't catch up, so it was left as it was: /u,
      ) as unknown,
      generated: {
        file: {
          path: relative(process.cwd(), join(project.dir, "migrations", "current.sql")),
          action: "written",
          handEdited: false,
        },
        hazards: [{ kind: "data_loss", statement: DROP_EMAIL }],
        hints: [],
      },
    },
  });
  expect(project.stderr).toBe("");
});
