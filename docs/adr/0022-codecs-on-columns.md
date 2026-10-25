---
status: accepted
---

# Codecs on columns, applied by the query layer

A column overrides its TypeScript mapping with a Codec, `c.date().codec(plainDate)`, which the query layer runs after the driver on select and before it on insert. The driver keeps returning ADR-0010's base values, so the query layer is a translation layer between those and the values the application wants. A Codec is a standalone value, `Codec<Base, Value>` with `decode` and `encode` typed against the column's base value, and not a port, because no adapter supplies one.

## Considered Options

- **Codecs per Postgres type, registered with the driver**: postgres.js decodes by type OID, but enum, domain, and array OIDs differ per database, so the connect step would need a catalog read to build the map. Two columns of one type could not decode differently.
- **Both layers, type defaults in the driver and column overrides in the query layer**: two mechanisms to explain and test for little gain.
- **Codec as a port in `runtime/ports`**: implies each adapter supplies codecs, which none does.

## Consequences

- `Row` and `NewRow` read the codec's `Value`, or `Value | null` for a nullable column. A column takes one codec; a second `.codec()` is a type error.
- Codecs decode every output that comes from a column ref, such as `from` selects and `insert ... returning`, matched by output alias. They encode insert values and any predicate value compared against a codec'd column. A raw `sql` template runs no codecs and returns base values.
- NULL never reaches a codec, either way. A codec that throws rejects the query, naming the table and column.
- On an array column, the element's codec runs per element and NULL elements skip it. Array base values follow the scalar mapping: `bigint[]` decodes to `bigint[]` and `numeric[]` to `string[]`. A codec on a whole array is not offered.
- A codec has no catalog effect, so adding or changing one generates no migration.
- ADR-0010's mappings stay the defaults. One codec ships, `plainDate`, which maps `date` to `Temporal.PlainDate`. It reads `globalThis.Temporal` when it runs and throws when it is missing, so the runtime keeps zero dependencies (ADR-0006) and a polyfill or a Node with Temporal both work. Node 24 has no Temporal.
- Temporal codecs for `timestamp` and `timestamptz` wait, because their base value is a `Date`, which has already dropped the microseconds.
