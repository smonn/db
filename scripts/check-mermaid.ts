import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownFiles } from "./markdown-files.ts";

function main(): void {
  const outDir = mkdtempSync(join(tmpdir(), "check-mermaid-"));
  // Ubuntu 24.04 runners block Chrome's user-namespace sandbox; the input is the repo's own docs.
  const puppeteerConfig = join(outDir, "puppeteer.json");
  writeFileSync(puppeteerConfig, JSON.stringify({ args: ["--no-sandbox"] }));

  let failed = false;
  const files = markdownFiles().filter((file) => readFileSync(file, "utf8").includes("```mermaid"));
  for (const [index, file] of files.entries()) {
    console.log(`Rendering ${file}`);
    const result = spawnSync(
      "mmdc",
      ["-q", "-p", puppeteerConfig, "-i", file, "-o", join(outDir, `${index}.md`)],
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
