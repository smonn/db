---
status: accepted
---

# The diff ignores unmodeled objects

Generating the Current migration only touches the kinds of objects the Definition can express. Anything else in the Shadow database, such as a trigger or function from a hand-written migration, is left alone rather than dropped, and can optionally be reported as a warning naming the version that plans to support it. Without this rule, every Postgres feature the Definition lacks would break hand-written SQL, the escape hatch ADR-0002 and ADR-0003 rely on.
