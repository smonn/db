# Prototype: watch mode's terminal output

Throwaway, for [Watch mode's terminal output has no design](https://github.com/smonn/db/issues/774). Never merged.

```sh
node prototypes/watch-output/watch-output.ts a   # timestamped append-only log
node prototypes/watch-output/watch-output.ts b   # clear and redraw, latest run only
node prototypes/watch-output/watch-output.ts c   # plain grouped runs, no timestamps
```

Add `--fast` to skip the pauses. Each variant plays the same session: start, a change that drops a column, a no-change save, a failed load, and the fix.
