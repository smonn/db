/**
 * The lines that differ between two texts: `-` for a line only in `from`, `+` for a line only in
 * `to`. Unchanged lines are left out. Empty when the texts have the same lines.
 */
export function lineDiff(from: string, to: string): string {
  const a = lines(from);
  const b = lines(to);
  // lcs[i][j] is the longest common subsequence length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let out = "";
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j === b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out += `-${a[i++]}\n`;
    } else {
      out += `+${b[j++]}\n`;
    }
  }
  return out;
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}
