---
status: accepted
---

# One TypeScript config per Database, loaded by plain import

Each Database gets its own `smonndb.config.ts`, whose default export `defineConfig({ definition, migrations, url, trackingSchema? })` describes that one Database, and the CLI picks another with `--config <path>`. Most projects hold a single Database, so a map of Databases would add a concept that only a few projects use. The CLI loads the file with a plain `import()` on Node's built-in type stripping, which keeps the CLI free of dependencies.

## Considered Options

- **A `databases` map in one config, picked with `--database`**: names stay unique for free, but every project pays for a concept most never need.
- **A TypeScript loader such as jiti or tsx**: allows enums and extensionless imports, but adds a dependency to the CLI.
- **Searching parent directories for the config**: matches most tools, but the CLI then acts on a file the user may not know it found.

## Consequences

- Config and Definition files use erasable TypeScript only and write `.ts` extensions in relative imports. The docs point to Node's TypeScript guide and its `erasableSyntaxOnly` and `verbatimModuleSyntax` settings.
- `url` comes from the environment through the config, so the CLI has no `--url` flag: `DATABASE_URL=... smonndb migrate`.
- A watch mode in v0.4 has to bypass the ESM import cache to reload a changed Definition.
