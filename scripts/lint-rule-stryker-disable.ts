/**
 * `smonn/stryker-disable`, a rule of `lint-plugin.ts` in its own file to keep each file's fta score
 * low: every comment Stryker reads as a directive has the one form `stryker-directive.ts` allows,
 * alone on its line and directly above code, where the weekly run's marker can find it.
 */
import type { RuleTester } from "oxlint/plugins-dev";
import { directiveProblem, FORM_MESSAGE, isStrykerDirective } from "./stryker-directive.ts";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Comment = ReturnType<Context["sourceCode"]["getAllComments"]>[number];

const PLACEMENT_MESSAGE =
  "Put a Stryker directive alone on its line, directly above the code it covers: the weekly run reads it as covering the next line";

function placementProblem(comment: Comment, text: string): string | undefined {
  const before = text.slice(text.lastIndexOf("\n", comment.start) + 1, comment.start).trim();
  const next = (text.slice(comment.end).split("\n", 2)[1] ?? "").trim();
  if (before !== "" || next === "" || next.startsWith("//")) return PLACEMENT_MESSAGE;
  return undefined;
}

function commentProblem(comment: Comment, text: string): string | undefined {
  if (!isStrykerDirective(comment.value)) return undefined;
  if (comment.type === "Block") return FORM_MESSAGE;
  return directiveProblem(comment.value) ?? placementProblem(comment, text);
}

export const strykerDisableRule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Allow only line-scoped, reasoned Stryker disable comments" },
  },
  create(context) {
    return {
      Program() {
        const { text } = context.sourceCode;
        for (const comment of context.sourceCode.getAllComments()) {
          const message = commentProblem(comment, text);
          if (message !== undefined) context.report({ loc: comment.loc, message });
        }
      },
    };
  },
};
