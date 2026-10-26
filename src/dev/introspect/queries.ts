const NOT_EXTENSION_MEMBER = (catalog: string, alias: string): string => `not exists (
  select from pg_depend d
  where d.classid = '${catalog}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e'
)`;

const KEPT_SCHEMA = `n.nspname !~ '^pg_' and n.nspname not in ('information_schema', $1)`;

// Whether `expression` calls a function `pg_proc` marks volatile, matched by name since
// `pg_depend` omits built-in functions. String literals are stripped so `'f('` names no call.
const CALLS_VOLATILE = (expression: string): string => `exists (
    select from regexp_matches(
      regexp_replace(${expression}, '''([^'']|'''')*''', '', 'g'),
      '([A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\\s*\\(', 'g'
    ) as call(name)
      join pg_proc p on p.proname = trim(both '"' from call.name[1])
    where p.provolatile = 'v'
  )`;

export const SCHEMAS: string = `
select n.nspname as name
from pg_namespace n
where ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_namespace", "n")}
order by n.nspname`;

export const TABLES: string = `
select n.nspname as schema, c.relname as name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by c.relname`;

// Labels come in sort order, which `enumsortorder` keeps across `ADD VALUE ... BEFORE`.
export const ENUMS: string = `
select n.nspname as schema, t.typname as name, array(
  select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder
) as labels
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where t.typtype = 'e' and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_type", "t")}
order by t.typname`;

// A domain over a domain or an array, or with a collation other than its base's, is an Unmodeled
// object (ADR-0023). NOT NULL folds `typnotnull` and a Postgres 18 `pg_constraint` NOT NULL row.
export const DOMAINS: string = `
select n.nspname as schema, t.typname as name, format_type(t.typbasetype, t.typtypmod) as base,
  t.typnotnull or exists (
    select from pg_constraint k where k.contypid = t.oid and k.contype = 'n'
  ) as not_null,
  pg_get_expr(t.typdefaultbin, 0) as default_expression,
  ${CALLS_VOLATILE("pg_get_expr(t.typdefaultbin, 0)")} as default_volatile
from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_type b on b.oid = t.typbasetype
where t.typtype = 'd' and b.typtype <> 'd' and b.typcategory <> 'A'
  and t.typcollation = b.typcollation and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_type", "t")}
order by t.typname`;

// The expression inside `CHECK (...)`, so a `NOT VALID` check reads like a valid one.
export const DOMAIN_CHECKS: string = `
select n.nspname as schema, t.typname as domain, k.conname as name,
  regexp_replace(pg_get_constraintdef(k.oid), '^CHECK \\((.*)\\)( NOT VALID)?$', '\\1') as expression
from pg_constraint k
  join pg_type t on t.oid = k.contypid
  join pg_namespace n on n.oid = t.typnamespace
where k.contype = 'c' and t.typtype = 'd' and ${KEPT_SCHEMA}
order by k.conname`;

// A column of an array of a composite or range type is an Unmodeled object (ADR-0005, ADR-0023).
export const COLUMNS: string = `
select n.nspname as schema, c.relname as table, a.attname as name,
  format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
  a.attidentity as identity, a.attgenerated as generated,
  case when a.attgenerated <> '' then pg_get_expr(d.adbin, d.adrelid) end as generation_expression,
  case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end as default_expression,
  case when a.attgenerated = '' then ${CALLS_VOLATILE("pg_get_expr(d.adbin, d.adrelid)")}
  end as default_volatile
from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and ${KEPT_SCHEMA}
  and not exists (
    select from pg_type t join pg_type e on e.oid = t.typelem
    where t.oid = a.atttypid and t.typcategory = 'A' and e.typtype in ('c', 'r')
  )
order by a.attnum`;

// A deferrable, INCLUDE, or WITHOUT OVERLAPS key reads like a plain one, so it is skipped as an
// Unmodeled object (ADR-0005), as is a single-column NULLS NOT DISTINCT unique: only a unique entry
// over two or more columns can declare it (ADR-0021). A multi-column one is modeled.
export const CONSTRAINTS: string = `
select n.nspname as schema, c.relname as table, k.conname as name, k.contype as type,
  i.indnullsnotdistinct as nulls_not_distinct,
  array(
    select a.attname::text
    from unnest(k.conkey) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = key.attnum
    order by key.position
  ) as columns
from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_index i on i.indexrelid = k.conindid
where k.contype in ('p', 'u')
  and not k.condeferrable and not k.conperiod
  and i.indnkeyatts = i.indnatts
  and not (cardinality(k.conkey) = 1 and i.indnullsnotdistinct)
  and c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by k.conname`;

// An index is Unmodeled (ADR-0005) when it has another method, an opclass or collation other than
// the default, storage parameters, a tablespace, an expression key, or a predicate (expression
// keys and WHERE wait for #442), or is invalid (a failed CREATE INDEX CONCURRENTLY leaves one
// that the planner never uses). An index that backs a primary key, unique, or exclusion
// constraint is the constraint's fact, so it is skipped too; a foreign key's `conindid` is the
// referenced table's index, which stays an index. `orders` holds one `<asc|desc> nulls <first|last>`
// per key, read from `indoption`.
export const INDEXES: string = `
select n.nspname as schema, c.relname as table, ic.relname as name, am.amname as method,
  i.indisunique as is_unique, i.indnullsnotdistinct as nulls_not_distinct,
  array(
    select a.attname::text
    from unnest(i.indkey::int2[]) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = key.attnum
    where key.position <= i.indnkeyatts
    order by key.position
  ) as columns,
  array(
    select case when (o.option & 1) = 1 then 'desc' else 'asc' end
      || case when (o.option & 2) = 2 then ' nulls first' else ' nulls last' end
    from unnest(i.indoption::int2[]) with ordinality as o(option, position)
    where o.position <= i.indnkeyatts
    order by o.position
  ) as orders,
  array(
    select a.attname::text
    from unnest(i.indkey::int2[]) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = key.attnum
    where key.position > i.indnkeyatts
    order by key.position
  ) as include
from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  join pg_am am on am.oid = ic.relam
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
where am.amname in ('btree', 'hash', 'gin', 'gist', 'brin')
  and i.indisvalid and i.indexprs is null and i.indpred is null
  and ic.reloptions is null and ic.reltablespace = 0
  and not exists (
    select from pg_constraint k
    where k.conindid = i.indexrelid and k.contype in ('p', 'u', 'x')
  )
  and not exists (
    select from unnest(i.indclass::oid[]) with ordinality as oc(opclass, position)
      join pg_opclass op on op.oid = oc.opclass
    where oc.position <= i.indnkeyatts and not op.opcdefault
  )
  and not exists (
    select from unnest(i.indkey::int2[], i.indcollation::oid[]) with ordinality
        as k(attnum, coll, position)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where k.position <= i.indnkeyatts and k.coll <> a.attcollation
  )
  and c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by ic.relname`;

// A foreign key reads like a plain one unless it is NOT ENFORCED, uses PERIOD, or names a column
// list on SET NULL or SET DEFAULT, each of which is an Unmodeled object (ADR-0005). NOT VALID is
// the same fact as a valid key. A key to an Unmodeled table is skipped in `read`, which knows the
// tables it modeled.
export const FOREIGN_KEYS: string = `
select n.nspname as schema, c.relname as table, k.conname as name,
  tn.nspname as target_schema, tc.relname as target_table,
  array(
    select a.attname::text
    from unnest(k.conkey) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = key.attnum
    order by key.position
  ) as columns,
  array(
    select a.attname::text
    from unnest(k.confkey) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = k.confrelid and a.attnum = key.attnum
    order by key.position
  ) as target_columns,
  k.confdeltype as on_delete, k.confupdtype as on_update, k.confmatchtype as match,
  k.condeferrable as deferrable, k.condeferred as deferred
from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_class tc on tc.oid = k.confrelid
  join pg_namespace tn on tn.oid = tc.relnamespace
where k.contype = 'f' and k.conenforced and not k.conperiod and k.confdelsetcols is null
  and c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by k.conname`;
