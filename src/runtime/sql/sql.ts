import { quoteIdentifier } from "../internal/index.ts";

export type RenderedSql = {
  readonly text: string;
  readonly params: unknown[];
};

type Part = { readonly text: string } | { readonly value: unknown };

/** SQL text with its values held apart, so no value is ever spliced into the text. */
export class Fragment {
  readonly #parts: readonly Part[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    const parts: Part[] = [];
    for (const [index, text] of strings.entries()) {
      parts.push({ text });
      if (index < values.length) {
        const value = values[index];
        if (value instanceof Fragment) parts.push(...value.#parts);
        else parts.push({ value });
      }
    }
    this.#parts = parts;
  }

  /**
   * The text with each value replaced by what `inline` returns, for DDL, which binds nothing.
   * `undefined` when `piece` is no Fragment.
   */
  static inline(piece: unknown, inline: (value: unknown) => string): string | undefined {
    if (!(piece instanceof Fragment)) return undefined;
    return piece.#parts.map((part) => ("text" in part ? part.text : inline(part.value))).join("");
  }

  /** Numbers the values `$1`, `$2`, and so on, as the Driver's `query` binds them. */
  toSql(): RenderedSql {
    let text = "";
    const params: unknown[] = [];
    for (const part of this.#parts) {
      if ("text" in part) {
        text += part.text;
      } else {
        params.push(part.value);
        text += `$${params.length}`;
      }
    }
    return { text, params };
  }
}

/** Binds each interpolated value as a param, except a Fragment, whose SQL is inlined. */
export function fragment(strings: TemplateStringsArray, ...values: unknown[]): Fragment {
  return new Fragment(strings, values);
}

/** `piece` as DDL text, with each value replaced by what `inline` returns; `undefined` for a non-Fragment. */
export function inlineSql(piece: unknown, inline: (value: unknown) => string): string | undefined {
  return Fragment.inline(piece, inline);
}

export function identifier(name: string): Fragment {
  return new Fragment([quoteIdentifier(name)], []);
}

export function join(fragments: readonly Fragment[], separator: Fragment): Fragment {
  const values = fragments.flatMap((piece, index) => (index === 0 ? [piece] : [separator, piece]));
  return new Fragment(["", ...values.map(() => "")], values);
}
