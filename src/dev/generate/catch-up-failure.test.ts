import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
} from "../../runtime/definition/index.ts";
import { commit } from "./commit.ts";
import { CatchUpFailedError, generate, type GenerateResult } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

type Definition = Parameters<typeof generate>[0]["definition"];

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const withEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
});

const DROP_EMAIL = 'alter table "public"."users" drop column "email";';
const WRITTEN = `-- hazard: data_loss\n${DROP_EMAIL}\n`;

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

function generateWith(
  fileSystem: MemoryFileSystem,
  definition: Definition,
): Promise<GenerateResult> {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
  });
}

/** A Dev database holding one Committed migration that creates users with an email. */
async function committedWithEmail(): Promise<MemoryFileSystem> {
  const fileSystem = memoryFileSystem();
  await generateWith(fileSystem, withEmail);
  await commit({
    driver: db.driver,
    fileSystem,
    migrations: MIGRATIONS,
    slug: "create-users",
    accept: [],
  });
  return fileSystem;
}

/** What the failed run threw, which the tests inspect. */
async function failureOf(run: Promise<unknown>): Promise<CatchUpFailedError> {
  const error: unknown = await run.then(
    () => {},
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof CatchUpFailedError)) {
    throw new TypeError("expected the run to fail with CatchUpFailedError", { cause: error });
  }
  return error;
}

async function columns(): Promise<unknown[]> {
  const { rows } = await db.driver.query(
    "select column_name from information_schema.columns where table_name = 'users' order by ordinal_position",
  );
  return rows.map((row) => row["column_name"]);
}

describe("a Dev database catch-up that fails after generate wrote current.sql", () => {
  it("throws the files and their Hazards with the failure, since the next run keeps the file", async () => {
    const fileSystem = await committedWithEmail();
    await db.driver.execute("create view public.emails as select email from public.users");

    const failure = await failureOf(generateWith(fileSystem, users));

    expect(failure.message).toMatch(
      /^the Dev database didn't catch up, so it was left as it was: current\.sql: .+; run smonndb reset to rebuild it from the files$/su,
    );
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.cause).toHaveProperty("message", failure.message);
    expect(failure.cause).toHaveProperty(
      "cause.message",
      expect.stringMatching(/^current\.sql: /u) as unknown,
    );
    expect(failure.generated).toStrictEqual({
      path: CURRENT,
      sql: WRITTEN,
      file: "written",
      hazards: [{ kind: "data_loss", statement: DROP_EMAIL }],
      hints: [],
    });
    expect(fileSystem.files.get(CURRENT)).toContain(DROP_EMAIL);
    expect(await columns()).toStrictEqual(["id", "email"]);
  });

  it("reports the file as kept on the next run, whose Hazards the first run already printed", async () => {
    const fileSystem = await committedWithEmail();
    await db.driver.execute("create view public.emails as select email from public.users");
    await failureOf(generateWith(fileSystem, users));

    const failure = await failureOf(generateWith(fileSystem, users));

    expect(failure.generated).toMatchObject({ file: "kept", sql: WRITTEN });
  });

  it("throws the files from the diff path too", async () => {
    const fileSystem = memoryFileSystem();
    await generateWith(fileSystem, withEmail);
    await db.driver.execute("create view public.emails as select email from public.users");

    const failure = await failureOf(generateWith(fileSystem, users));

    expect(failure.message).toMatch(/^the Dev database didn't catch up, /u);
    expect(failure.generated).toMatchObject({ path: CURRENT, file: "written", hazards: [] });
  });

  it("throws a hand-edited file with its diff", async () => {
    const fileSystem = await committedWithEmail();
    await db.driver.execute("create view public.emails as select email from public.users");
    const edited = "alter table public.users drop column email;\n";
    fileSystem.files.set(CURRENT, edited);

    const failure = await failureOf(generateWith(fileSystem, users));

    expect(failure.generated).toMatchObject({ path: CURRENT, sql: edited, file: "kept" });
    expect(failure.generated.diff).toContain(DROP_EMAIL);
  });

  it("rolls back and names reset when writing a marker fails", async () => {
    const fileSystem = await committedWithEmail();
    await db.driver.execute("alter table smonn_db.current add check (hash = 'never')");

    const failure = await failureOf(generateWith(fileSystem, users));

    expect(failure.message).toMatch(
      /^the Dev database didn't catch up, so it was left as it was: .*check constraint.*; run smonndb reset to rebuild it from the files$/su,
    );
    expect(await columns()).toStrictEqual(["id", "email"]);
    const { rows } = await db.driver.query("select hash from smonn_db.current");
    expect(rows).toStrictEqual([]);
  });
});

describe("generate and a Dev database that holds the other kind of type", () => {
  it("refuses an enum that the files make a domain, without claiming it wrote no migration", async () => {
    const fileSystem = memoryFileSystem();
    await generateWith(fileSystem, defineDatabase({ public: { mood: defineEnum(["a"]) } }));

    const failure = generateWith(
      fileSystem,
      defineDatabase({ public: { mood: defineDomain((c) => c.text()) } }),
    );

    await expect(failure).rejects.toThrow(
      `the Dev database didn't catch up, so it was left as it was: Generate can't replace the enum "public"."mood" with a domain of the same name in one migration: it creates types before it drops them, so the two would clash; run smonndb reset to rebuild it from the files`,
    );
    expect(fileSystem.files.get(CURRENT)).toContain("create domain");
  });
});
