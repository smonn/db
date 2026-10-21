---
status: proposed
---

# Commit accepts Hazards by kind

Generate writes each Hazard as a `-- hazard: <kind>` comment and never blocks, and `commit` refuses while the Current migration has a Hazard whose kind is not named in `--accept <kind,...>`. The gate sits at commit because ADR-0003 freezes regeneration once the Current migration is hand-edited, so accepting a Hazard by editing the file would stop generation. Accepting a Hazard should be a deliberate choice about each kind, so there is no flag that accepts them all.

## Considered Options

- **`--accept-hazards` for every kind**: one flag fewer, but it accepts data loss as readily as a table rewrite.
- **An interactive prompt**: agents and CI would behave differently from people at a terminal.
- **A strict mode that fails generate on chosen kinds**: worth revisiting after v0.1, and it adds config v0.1 doesn't need.

## Consequences

- The refusal names each Hazard with its statement and prints the exact `--accept` flag to pass.
- The comments stay in the Committed migration, so reviewers see the accepted Hazards in the diff.
- A hand edit that deletes a Hazard comment removes its gate.
