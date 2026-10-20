---
status: proposed
---

# Zero-dependency runtime in one package

The library ships as one npm package whose runtime has no dependencies except the driver as a peer, is free of side effects, and never imports dev-time code. The diff, Shadow database, generator, and CLI live behind separate subpath exports. One package means one install for both the CLI and the runtime, as with Prisma, while the split keeps production footprint small and lets bundled apps install it as a dev dependency. Modules are laid out along future package boundaries so a workspace split stays cheap when a second adapter brings its own dependencies.
