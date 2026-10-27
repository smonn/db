import { expect, test, vi } from "vitest";

vi.mock("./workflow-yaml-flow.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workflow-yaml-flow.ts")>();
  return {
    ...original,
    refuseNodeStart: (text: string, at: number): void => {
      if (text.startsWith("boom")) throw new RangeError("not an Unreadable");
      original.refuseNodeStart(text, at);
    },
  };
});

const { workflowYamlProblems } = await import("./workflow-yaml.ts");

test("lets an error that is not Unreadable through", () => {
  expect(() => workflowYamlProblems("boom: x\n", "w.yml")).toThrow(RangeError);
});

test("still reports an Unreadable form", () => {
  expect(workflowYamlProblems("a: &b\n", "w.yml")).toEqual([
    "w.yml line 1 uses an anchor (&), which this check can't read",
  ]);
});
