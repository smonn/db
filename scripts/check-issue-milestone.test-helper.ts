import type { IssueEvent } from "./check-issue-milestone.ts";

export function event(
  issue: Partial<IssueEvent["issue"]> = {},
  rest: Partial<Omit<IssueEvent, "issue">> = {},
): IssueEvent {
  return {
    action: "opened",
    issue: {
      number: 7,
      title: "Nothing flags a lowercase title",
      state: "open",
      milestone: null,
      labels: [],
      user: { type: "User" },
      ...issue,
    },
    repository: { full_name: "smonn/db", html_url: "https://github.com/smonn/db" },
    ...rest,
  };
}
