import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MARKER } from "./check-issue-labels.ts";
import {
  comment,
  commentsRoute,
  deleted,
  deletion,
  event,
  fetched,
  issueRoute,
  labelled,
  posted,
  run,
} from "./check-issue-labels.test-helper.ts";

describe("main reconciling the comment", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("deletes the marker comment once the gap is fixed", () => {
    const gh = run(event(fetched()), fetched(), [["hi", `${MARKER}\nolder text`]]);
    expect(deleted(gh)).toEqual([deletion(102)]);
    expect(posted(gh)).toEqual([]);
  });

  test("deletes every marker comment, across pages", () => {
    const gh = run(event(fetched(), "unlabeled"), fetched(), [[MARKER, "hi"], [MARKER]]);
    expect(deleted(gh)).toEqual([deletion(101), deletion(103)]);
  });

  test("keeps the marker comment while a label is still missing", () => {
    const current = fetched({ labels: labelled("ready-for-agent", "bug") });
    const gh = run(event(current), current, [[MARKER]]);
    expect(deleted(gh)).toEqual([]);
    expect(posted(gh)).toEqual([]);
  });

  test("warns again when a fixed issue breaks again", () => {
    const broken = fetched({ labels: labelled("ready-for-agent", "bug") });
    const fixed = run(event(fetched()), fetched(), [[MARKER]]);
    expect(deleted(fixed)).toEqual([deletion(101)]);
    const again = run(event(broken, "unlabeled"), broken, [["hi"]]);
    expect(posted(again)).toEqual([comment("no `priority:*` label")]);
  });

  test("deletes the marker comment when the event removed the ready label", () => {
    const unready = fetched({ labels: labelled("priority:low", "bug") });
    const gh = run(event(unready, "unlabeled", "ready-for-agent"), unready, [[MARKER]]);
    expect(deleted(gh)).toEqual([deletion(101)]);
    expect(posted(gh)).toEqual([]);
  });

  test("leaves a human's comment that quotes the marker", () => {
    const quoted = { body: MARKER, human: true } as const;
    expect(deleted(run(event(fetched()), fetched(), [[quoted]]))).toEqual([]);
  });

  test("makes no write call on a compliant issue without a marker comment", () => {
    const gh = run(event(fetched()), fetched(), [["hi"]]);
    expect(deleted(gh)).toEqual([]);
    expect(posted(gh)).toEqual([]);
    expect(gh.mock.calls.map(([args]) => args)).toEqual([
      ["api", issueRoute],
      ["api", "--paginate", "--slurp", commentsRoute],
    ]);
  });

  test("ignores a marker a human quoted", () => {
    const current = fetched({ labels: labelled("ready-for-agent") });
    const quoted = { body: MARKER, human: true } as const;
    expect(posted(run(event(current), current, [[quoted]]))).toEqual([
      comment("no `priority:*` label and no category label"),
    ]);
  });

  test("clears the comment of an issue that lost its ready label since the event", () => {
    const stale = fetched({ labels: labelled("ready-for-agent") });
    const live = { ...stale, labels: labelled("needs-triage") };
    expect(deleted(run(event(stale), live, [[MARKER]]))).toEqual([deletion(101)]);
  });
});
