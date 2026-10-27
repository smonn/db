import { afterEach, expect, it, vi } from "vitest";

const argv = [...process.argv];

afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.resetModules();
  vi.doUnmock("./main.ts");
});

it("runs main on the arguments after node and the script, and exits with its code", async () => {
  const main = vi.fn<(args: readonly string[]) => Promise<number>>(() => Promise.resolve(2));
  vi.doMock("./main.ts", () => ({ main }));
  process.argv = ["node", "smonndb", "migrate", "--config", "other.config.ts"];

  await import("./bin.ts");

  expect(main).toHaveBeenCalledExactlyOnceWith(["migrate", "--config", "other.config.ts"]);
  expect(process.exitCode).toBe(2);
});
