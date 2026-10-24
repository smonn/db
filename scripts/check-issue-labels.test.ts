import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MARKER, main, needsLabelCheck } from "./check-issue-labels.ts";
import {
  comment,
  event,
  fakeGh,
  fetched,
  labelled,
  posted,
  run,
  writeEvent,
} from "./check-issue-labels.test-helper.ts";

describe("main", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("names a missing priority", () => {
    const current = fetched({ labels: labelled("ready-for-agent", "bug") });
    expect(posted(run(event(current)))).toEqual([comment("no `priority:*` label")]);
  });

  test("names two priorities", () => {
    const current = fetched({
      labels: labelled("ready-for-agent", "priority:low", "priority:high", "bug"),
    });
    expect(posted(run(event(current)))).toEqual([
      comment("2 `priority:*` labels (`priority:low`, `priority:high`)"),
    ]);
  });

  test("names a missing category", () => {
    const current = fetched({ labels: labelled("ready-for-human", "priority:low") });
    expect(posted(run(event(current)))).toEqual([comment("no category label")]);
  });

  test("names both categories", () => {
    const current = fetched({
      labels: labelled("ready-for-agent", "priority:low", "bug", "enhancement"),
    });
    expect(posted(run(event(current)))).toEqual([
      comment("2 category labels (`bug`, `enhancement`)"),
    ]);
  });

  test("names both gaps in one comment", () => {
    const current = fetched({ labels: labelled("ready-for-agent") });
    expect(posted(run(event(current)))).toEqual([
      comment("no `priority:*` label and no category label"),
    ]);
  });

  test("stays quiet on a complete issue", () => {
    expect(posted(run(event(fetched())))).toEqual([]);
  });

  test("stays quiet on a bot-opened issue without reading it", () => {
    const current = fetched({ labels: labelled("ready-for-agent"), user: { type: "Bot" } });
    expect(run(event(current))).not.toHaveBeenCalled();
  });

  test("stays quiet when a marker comment exists", () => {
    const current = fetched({ labels: labelled("ready-for-agent") });
    expect(posted(run(event(current), current, [["hi", `${MARKER}\nolder text`]]))).toEqual([]);
  });

  test("finds a marker on a later page of comments", () => {
    const current = fetched({ labels: labelled("ready-for-agent") });
    expect(posted(run(event(current), current, [["hi"], [MARKER]]))).toEqual([]);
  });

  test("judges the live labels, not the event's", () => {
    const stale = fetched({ labels: labelled("ready-for-agent") });
    expect(posted(run(event(stale), fetched()))).toEqual([]);
  });

  test("skips an issue that closed or lost its ready label since the event", () => {
    const stale = fetched({ labels: labelled("ready-for-agent") });
    expect(posted(run(event(stale), { ...stale, state: "closed" }))).toEqual([]);
    expect(posted(run(event(stale), { ...stale, labels: labelled("needs-triage") }))).toEqual([]);
  });

  test("reports a malformed event with the path that broke", () => {
    const path = writeEvent({ action: "labeled" }, "bad.json");
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, fakeGh({}));
    }).toThrow(/\$\.repository/u);
  });

  test("fails without GITHUB_EVENT_PATH", () => {
    main({}, fakeGh({}));
    expect(process.exitCode).toBe(1);
  });
});

describe("needsLabelCheck", () => {
  test("accepts an open ready issue on labeled and unlabeled", () => {
    for (const action of ["labeled", "unlabeled"]) {
      expect(needsLabelCheck(event(fetched(), action))).toBe(true);
    }
  });

  test("accepts either ready label", () => {
    for (const ready of ["ready-for-agent", "ready-for-human"]) {
      expect(needsLabelCheck(event(fetched({ labels: labelled(ready) })))).toBe(true);
    }
  });

  test("ignores other actions", () => {
    for (const action of ["opened", "edited", "closed", "milestoned"]) {
      expect(needsLabelCheck(event(fetched(), action))).toBe(false);
    }
  });

  test("skips a closed issue, a bot issue, and an issue that is not ready", () => {
    expect(needsLabelCheck(event(fetched({ state: "closed" })))).toBe(false);
    expect(needsLabelCheck(event(fetched({ user: { type: "Bot" } })))).toBe(false);
    expect(needsLabelCheck(event(fetched({ labels: labelled("needs-triage") })))).toBe(false);
  });
});
