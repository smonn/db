import { describe, expectTypeOf, it } from "vitest";
import type { CommitOptions, GenerateOptions, ResetOptions } from "./index.ts";

type Forwarded = { readonly signal: AbortSignal | undefined };

describe("the signal option", () => {
  it("takes undefined, so a caller can forward a signal it may not have", () => {
    expectTypeOf<Forwarded>().toExtend<Pick<GenerateOptions, "signal">>();
    expectTypeOf<Forwarded>().toExtend<Pick<CommitOptions, "signal">>();
    expectTypeOf<Forwarded>().toExtend<Pick<ResetOptions, "signal">>();
  });
});
