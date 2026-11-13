import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  entry: {
    index: "src/runtime/index.ts",
    "postgres-js": "src/adapters/postgres-js/index.ts",
    node: "src/adapters/node/index.ts",
    dev: "src/dev/index.ts",
    cli: "src/dev/cli/bin.ts",
    // loadDefinitionInWorker starts it by its built name, beside the chunk that holds the loader.
    "definition-worker": "src/dev/cli/definition-worker.ts",
  },
  platform: "node",
  dts: true,
  exports: { exclude: ["cli", "definition-worker"], bin: { smonndb: "src/dev/cli/bin.ts" } },
});

export default config;
