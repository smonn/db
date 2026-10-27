/**
 * Renders every Mermaid block in the repo's Markdown with mermaid-cli (`mmdc`) and exits 1 if any
 * fails to parse or render. Output goes to a temp directory and is discarded.
 *
 * Run from the repo root with `pnpm check:mermaid`; CI runs it in the Mermaid job. It needs the
 * Chrome that puppeteer downloads on install.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownFiles } from "./markdown-files.ts";

export function main(cwd: string = process.cwd()): void {
  const outDir = mkdtempSync(join(tmpdir(), "check-mermaid-"));
  // Ubuntu 24.04 runners block Chrome's user-namespace sandbox; the input is the repo's own docs.
  const puppeteerConfig = join(outDir, "puppeteer.json");
  writeFileSync(puppeteerConfig, JSON.stringify({ args: ["--no-sandbox"] }));

  let failed = false;
  const files = markdownFiles(cwd).filter((file) =>
    readFileSync(join(cwd, file), "utf8").includes("```mermaid"),
  );
  for (const [index, file] of files.entries()) {
    console.log(`Rendering ${file}`);
    const result = spawnSync(
      "mmdc",
      ["-q", "-p", puppeteerConfig, "-i", join(cwd, file), "-o", join(outDir, `${index}.md`)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.error(`${file}: a Mermaid block failed to render`);
      failed = true;
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}

if (import.meta.main) main();
