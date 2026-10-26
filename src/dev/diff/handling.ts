import type { Action, Catalogs } from "./actions.ts";

/**
 * What the diff does with one kind of fact. Every field is required, so a new `Fact` kind fails to
 * compile until its author states each decision.
 */
export type Handling<F extends { readonly kind: string }> = {
  /** Whether dropping the parent drops this fact too, so it needs no action of its own. */
  readonly parentDropCovers: boolean;
  readonly drop: (fact: F) => Action[];
  /** Whether creating the parent creates this fact inline, so it needs no action of its own. */
  readonly parentCreateCovers: boolean;
  readonly create: (fact: F) => Action[];
  /** Whether a changed payload drops the fact and creates it again, rather than altering it. */
  readonly replacedOnChange: boolean;
  /** Compares two facts of this kind at one key that the source pass didn't replace. */
  readonly alter: (before: F, after: F, catalogs: Catalogs) => Action[];
  /** The columns of its parent table the fact names, so a rebuilt one drops and re-adds it. */
  readonly columnsNamed: (fact: F) => readonly string[];
};

/** One `Handling` per kind of `F`; the test widens `F` to prove a new kind has to fill each field. */
export type HandlingTable<F extends { readonly kind: string }> = {
  readonly [K in F["kind"]]: Handling<Extract<F, { readonly kind: K }>>;
};
