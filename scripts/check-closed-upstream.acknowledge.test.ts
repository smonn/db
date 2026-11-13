import { spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { main } from "./check-closed-upstream.ts";
import {
  commentsPath,
  ghReplies,
  openIssues,
  own,
  quietMain,
  synthetic,
  upstreamPath,
} from "./check-closed-upstream.test-helper.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const spawn = vi.mocked(spawnSync);
const upstream = "https://github.com/pnpm/pnpm/issues/9";
const closed = JSON.stringify({ state: "closed", html_url: upstream });
const none = "No open issue cites a closed upstream issue.";

describe("main with an acknowledged citation", () => {
  quietMain(spawn);

  test("skips one acknowledged in the body, by any form of the reference", () => {
    const body = `Waits on ${upstream}\n<!-- smonn-db:upstream-ack PNPM/pnpm#9: kept on purpose -->`;
    ghReplies(spawn, { [openIssues]: JSON.stringify([[synthetic({ body })]]) });
    main();
    expect(console.log).toHaveBeenCalledWith(none);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("skips one acknowledged in a comment, and one marker covers several", () => {
    ghReplies(spawn, {
      [openIssues]: JSON.stringify([
        [synthetic({ body: `Waits on ${upstream} and pnpm/pnpm#10`, comments: 1 })],
      ]),
      [commentsPath(3)]: JSON.stringify([
        [
          {
            html_url: `${own}/3#issuecomment-1`,
            body: "<!--smonn-db:upstream-ack\n pnpm/pnpm#9 https://github.com/pnpm/pnpm/pull/10\n-->",
          },
        ],
      ]),
    });
    main();
    expect(console.log).toHaveBeenCalledWith(none);
  });

  test("checks a citation the marker does not name, and one in another issue", () => {
    const body = `${upstream} pnpm/pnpm#10 <!-- smonn-db:upstream-ack pnpm/pnpm#9 -->`;
    ghReplies(spawn, {
      [openIssues]: JSON.stringify([
        [synthetic({ body }), synthetic({ number: 4, html_url: `${own}/4`, body: upstream })],
      ]),
      [upstreamPath("pnpm/pnpm", 9)]: closed,
      [upstreamPath("pnpm/pnpm", 10)]: closed,
    });
    main();
    expect(console.log).toHaveBeenCalledWith(
      [
        `#3 cites pnpm/pnpm#10, closed (${upstream}); cited in ${own}/3`,
        `#4 cites pnpm/pnpm#9, closed (${upstream}); cited in ${own}/4`,
      ].join("\n"),
    );
  });

  test("reads a marker that is not the acknowledgement as an ordinary citation", () => {
    ghReplies(spawn, {
      [openIssues]: JSON.stringify([
        [synthetic({ body: "<!-- smonn-db:upstream-acknowledged pnpm/pnpm#9 -->" })],
      ]),
      [upstreamPath("pnpm/pnpm", 9)]: closed,
    });
    main();
    expect(process.exitCode).toBe(1);
  });
});
