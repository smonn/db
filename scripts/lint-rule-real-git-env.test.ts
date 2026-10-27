import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./lint-plugin.ts";

// oxlint-disable-next-line typescript/strict-void-return -- RuleTester ignores what describe returns.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const CLEAR_GIT_ENV = 'import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";\n';
const BEFORE_EACH = `${CLEAR_GIT_ENV}beforeEach(() => { isolateGitEnv(); });\n`;

tester.run("real-git-env", plugin.rules["real-git-env"], {
  valid: [
    `${BEFORE_EACH}execFileSync("git", ["init"], { cwd });`,
    `${BEFORE_EACH}child_process.spawnSync("git", ["status"]);`,
    'expect(execFileSync).toHaveBeenCalledWith("git", ["show", "HEAD"]);',
    'vi.mocked(execFileSync).mockReturnValue("");',
    'execFileSync("gh", ["pr", "view"]);',
    "execFileSync(command, args, options);",
    'execSync("github-cli --version");',
    `${BEFORE_EACH}execSync(\`git init\`);`,
    `${BEFORE_EACH}execFileSync("/usr/bin/git", []);`,
    'import * as h from "./git-env.test-helper.ts";\nbeforeEach(() => { h.isolateGitEnv(); });\nexecFileSync("git", []);',
    'mocks.execFileSync("git", ["init"]);',
    'import { execFileSync as run } from "node:child_process";\nrun("gh", []);',
    'import { spawn as run } from "node:child_process";\nother.run("git", []);',
    'import * as cp from "node:child_process";\ncp[execFileSync]("git", []);',
    'import * as tools from "./tools.ts";\ntools.execFileSync("git", []);',
    'import { fork as run } from "node:child_process";\nrun("git", []);',
    'child_process.toString("git");',
    'print("git status");',
    'execSync("legit status");',
    "execSync(`${dir}/git status`);",
    "execSync(`gh ${command}`);",
    "execFileSync();",
    `${CLEAR_GIT_ENV}beforeEach(function () { isolateGitEnv(); });\nexecFileSync("git", []);`,
    `${CLEAR_GIT_ENV}beforeEach(() => isolateGitEnv());\nexecFileSync("git", []);`,
  ],
  invalid: [
    {
      code: 'execFileSync("git", ["init"], { cwd });',
      errors: [{ message: /isolateGitEnv\(\) from git-env\.test-helper\.ts/u }],
    },
    {
      code: 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["status"]);\nchild_process.spawn("git", []);',
      errors: 2,
    },
    {
      code: 'execSync("git init");',
      errors: 1,
    },
    {
      code: "exec(`git commit -m ${message}`);",
      errors: 1,
    },
    {
      code: 'import { isolateGitEnv } from "./elsewhere.ts";\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import { other } from "./git-env.test-helper.ts";\nexecFileSync("git", []);',
      errors: 1,
    },
    {
      code: 'import { execFileSync as run } from "node:child_process";\nrun("git", []);',
      errors: 1,
    },
    {
      code: 'import * as cp from "node:child_process";\ncp.execFileSync("git", []);',
      errors: 1,
    },
    {
      code: 'execFileSync("/usr/bin/git", []);',
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}isolateGitEnv();\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}it("x", () => { isolateGitEnv(); execFileSync("git", []); });`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}beforeEach(() => {});\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}beforeEach(() => { setup(); });\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}beforeEach(isolateGitEnv());\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}const setup = () => { isolateGitEnv(); };\nbeforeEach(setup);\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: 'import { isolateGitEnv } from "./elsewhere.ts";\nbeforeEach(() => { isolateGitEnv(); });\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import { other } from "./git-env.test-helper.ts";\nbeforeEach(() => { other(); });\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import isolate from "./git-env.test-helper.ts";\nbeforeEach(() => { isolate(); });\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import * as h from "./git-env.test-helper.ts";\nbeforeEach(() => { h.other(); other.isolateGitEnv(); });\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import * as cp from "child_process";\ncp.execFileSync("git", []);',
      errors: 1,
    },
  ],
});
