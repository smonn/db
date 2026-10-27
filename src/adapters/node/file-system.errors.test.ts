import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { nodeFileSystem } from "./file-system.ts";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn<typeof readFile>(),
  readdir: vi.fn<typeof readdir>(),
}));

// What reaches the catch clause is whatever the call rejects with, which a real read never makes
// anything but an Error.
const notAnError = { code: "ENOENT" };

describe("nodeFileSystem when a read rejects with something other than an Error", () => {
  it("rethrows it from readFile", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(notAnError);

    await expect(nodeFileSystem().readFile("a.sql")).rejects.toBe(notAnError);
  });

  it("rethrows it from list", async () => {
    vi.mocked(readdir).mockRejectedValueOnce(notAnError);

    await expect(nodeFileSystem().list("migrations")).rejects.toBe(notAnError);
  });
});
