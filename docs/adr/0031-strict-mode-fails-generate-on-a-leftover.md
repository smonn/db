---
status: proposed
---

# Strict mode fails generate on a leftover

ADR-0013 lets generate print a hand edit's Leftover as a warning and succeed, and it deferred a mode that fails on one; that mode is `strict: true` in `smonndb.config.ts`, off by default. With it on, generate exits 1 before it touches the Dev database and refuses only a Leftover, never a Hazard, because commit already gates each Hazard kind (ADR-0015) and watch must not stop on a save that drops data. A config key makes every person, agent, and CI run behave the same, and a hand edit stays the way around an Unmodeled object when the key is off.

## Considered Options

- **Refuse Hazards at generate time**: commit's per-kind gate already covers them, so ADR-0015 stays as it is.
- **A flag per run**: easy to forget, so one person's run would pass what another's refuses.

## Consequences

- The refusal reads `error: current.sql leaves a difference from the Definition (strict mode, <config path>):`, then the Leftover, then both fixes: fix the hand edit, or set `strict: false`.
- It applies to generate only, not migrate. Generate fails before the Dev database changes, so commit's replay check refuses the same edit.
- The v0.4 milestone called this a strict hazard mode. It refuses no Hazard, and the milestone now says strict mode.
- Watch counts a strict refusal as a failed run (ADR-0032), and `--json` reports it as the `leftover` error code (ADR-0033).
