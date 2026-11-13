const CONTEXT = 3;

type Edit = { readonly mark: " " | "-" | "+"; readonly text: string };

/**
 * A unified diff from `from` to `to`, like `diff -u` without the file headers: `-` marks a line
 * only in `from`, `+` a line only in `to`, with 3 unchanged lines of context around each change
 * under an `@@ -a,b +c,d @@` header. Changes at most 6 lines apart share a hunk. Empty when the
 * texts have the same lines.
 */
export function lineDiff(from: string, to: string): string {
  const a = lines(from);
  const b = lines(to);
  const edits = editScript(a, b, lcsTable(a, b));
  return hunks(edits)
    .map((hunk) => renderHunk(edits, hunk))
    .join("");
}

/** `lcs[i][j]` is the longest common subsequence length of `a[i..]` and `b[j..]`. */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

function editScript(a: readonly string[], b: readonly string[], lcs: readonly number[][]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ mark: " ", text: a[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      edits.push({ mark: "-", text: a[i++]! });
    } else {
      edits.push({ mark: "+", text: b[j++]! });
    }
  }
  return [
    ...edits,
    ...a.slice(i).map((text): Edit => ({ mark: "-", text })),
    ...b.slice(j).map((text): Edit => ({ mark: "+", text })),
  ];
}

/** The `[start, end)` edit ranges of each hunk: runs of changes with their context, merged when they touch. */
function hunks(edits: readonly Edit[]): [number, number][] {
  const ranges: [number, number][] = [];
  edits.forEach((edit, index) => {
    if (edit.mark === " ") return;
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(edits.length, index + 1 + CONTEXT);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  });
  return ranges;
}

function renderHunk(edits: readonly Edit[], [start, end]: readonly [number, number]): string {
  const before = edits.slice(0, start);
  const body = edits.slice(start, end);
  const fromCount = body.filter((edit) => edit.mark !== "+").length;
  const toCount = body.filter((edit) => edit.mark !== "-").length;
  const fromBefore = before.filter((edit) => edit.mark !== "+").length;
  const toBefore = before.filter((edit) => edit.mark !== "-").length;
  const header = `@@ -${range(fromBefore, fromCount)} +${range(toBefore, toCount)} @@\n`;
  return header + body.map((edit) => `${edit.mark}${edit.text}\n`).join("");
}

/** `diff -u` numbers an empty range by the line before it, so one at the top is `0,0`. */
function range(before: number, count: number): string {
  return `${count === 0 ? before : before + 1},${count}`;
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}
