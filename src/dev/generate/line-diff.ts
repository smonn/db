/**
 * The lines that differ between two texts: `-` for a line only in `from`, `+` for a line only in
 * `to`. Unchanged lines are left out. Empty when the texts have the same lines.
 */
export function lineDiff(from: string, to: string): string {
  const a = lines(from);
  const b = lines(to);
  return diffLines(a, b, lcsTable(a, b));
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

function diffLines(a: readonly string[], b: readonly string[], lcs: readonly number[][]): string {
  let out = "";
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out += `-${a[i++]}\n`;
    } else {
      out += `+${b[j++]}\n`;
    }
  }
  return out + prefixed("-", a.slice(i)) + prefixed("+", b.slice(j));
}

function prefixed(mark: string, rest: readonly string[]): string {
  return rest.map((line) => `${mark}${line}\n`).join("");
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}
