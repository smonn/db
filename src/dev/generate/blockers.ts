import type { Queryable } from "../../runtime/ports/index.ts";
import type { Scan } from "../diff/index.ts";

/**
 * The objects that block the planned drops and retypes, one row per target and blocker, named by
 * `pg_identify_object`, which ignores `lc_messages` (ADR-0025). `$1` holds the scans as JSON.
 *
 * Drops share one transitive walk (#372): only `n` edges block, an object reached through any
 * other edge drops with its owner, and a dependent of one drop that another drop removes is no
 * blocker, as in a multi-object `DROP`. A column the plan retypes stops depending on a type it
 * drops, so the walk stops there and leaves its dependents to the retype. A retype reads the column's direct dependents of the kinds `ALTER COLUMN ... TYPE`
 * refuses, reported as their owner (a view for its rule, a column for its generation expression),
 * unless a planned drop removes them or they are a generation expression the plan drops first.
 * Inheritance (`pg_inherits`) is left to verification.
 */
const BLOCKERS = `
with recursive
planned as (
  select t.walk, a.classid, a.objid, a.objsubid
  from jsonb_to_recordset($1::text::jsonb) as t(walk text, type text, names text[], args text[])
    cross join lateral pg_get_object_address(t.type, t.names, t.args) a
),
dropped as (select classid, objid, objsubid from planned where walk = 'drop'),
retyped as (select classid, objid, objsubid from planned where walk = 'retype'),
removed as (select classid, objid from planned where walk = 'remove'),
closure(root_classid, root_objid, root_objsubid, classid, objid, objsubid) as (
  select classid, objid, objsubid, classid, objid, objsubid from dropped
  union
  select c.root_classid, c.root_objid, c.root_objsubid, x.classid, x.objid, x.objsubid
  from closure c cross join lateral (
    -- dependents of the node; a whole object covers its columns
    select d.classid, d.objid, d.objsubid from pg_depend d
    where d.refclassid = c.classid and d.refobjid = c.objid
      and (c.objsubid = 0 or d.refobjsubid = c.objsubid)
    union all
    -- the owner of an internally dependent node, which Postgres drops instead
    select d.refclassid, d.refobjid, d.refobjsubid from pg_depend d
    where d.classid = c.classid and d.objid = c.objid
      and (c.objsubid = 0 or d.objsubid = c.objsubid) and d.deptype = 'i'
  ) x
  -- a retyped column stays, so its dependents block only the retype
  where not exists (
    select from retyped t
    where t.classid = c.classid and t.objid = c.objid and t.objsubid = c.objsubid)
),
nodes as (select distinct classid, objid, objsubid from closure),
drop_blockers as (
  select distinct c.* from closure c
  where not exists (
      select from dropped t
      where t.classid = c.classid and t.objid = c.objid
        and (t.objsubid = 0 or t.objsubid = c.objsubid))
    and not exists (
      select from retyped t
      where t.classid = c.classid and t.objid = c.objid and t.objsubid = c.objsubid)
    -- a column is part of its table when the table is in the closure too
    and not (c.objsubid > 0 and exists (
      select from nodes w where w.classid = c.classid and w.objid = c.objid and w.objsubid = 0))
    -- reached through any edge but a normal one: dropped with its owner
    and not exists (
      select from pg_depend e
        join nodes r on r.classid = e.refclassid and r.objid = e.refobjid
          and (r.objsubid = 0 or r.objsubid = e.refobjsubid)
      where e.classid = c.classid and e.objid = c.objid
        and (c.objsubid = 0 or e.objsubid = c.objsubid)
        and not (e.refclassid = e.classid and e.refobjid = e.objid)
        and e.deptype <> 'n')
),
retype_blockers as (
  select distinct r.classid as root_classid, r.objid as root_objid, r.objsubid as root_objsubid,
    coalesce(o.refclassid, d.classid) as classid, coalesce(o.refobjid, d.objid) as objid,
    coalesce(o.refobjsubid, d.objsubid) as objsubid
  from retyped r
    join pg_depend d on d.refclassid = r.classid and d.refobjid = r.objid
      and d.refobjsubid = r.objsubid
    left join pg_depend o on o.classid = d.classid and o.objid = d.objid and o.deptype = 'i'
  where d.classid in ('pg_rewrite'::regclass, 'pg_proc'::regclass, 'pg_trigger'::regclass,
      'pg_policy'::regclass, 'pg_publication_rel'::regclass, 'pg_attrdef'::regclass)
    -- the column's own default or generation expression
    and not exists (
      select from pg_attrdef a
      where d.classid = 'pg_attrdef'::regclass and a.oid = d.objid
        and a.adrelid = r.objid and a.adnum = r.objsubid)
    -- a generation expression the plan drops before it retypes
    and not exists (select from removed m where m.classid = d.classid and m.objid = d.objid)
),
blockers as (
  -- a view's column changes only with its view, so it blocks as the view
  select distinct 'drop' as walk, b.root_classid, b.root_objid, b.root_objsubid, b.classid,
    b.objid, case when v.oid is null then b.objsubid else 0 end as objsubid
  from drop_blockers b
    left join pg_class v on b.classid = 'pg_class'::regclass and v.oid = b.objid
      and v.relkind in ('v', 'm')
  union all
  select 'retype', b.* from retype_blockers b
  -- a node of a drop's closure that blocks nothing drops before the retype
  where not exists (
    select from nodes n
    where n.classid = b.classid and n.objid = b.objid
      and (n.objsubid = 0 or n.objsubid = b.objsubid)
      and not exists (
        select from drop_blockers k
        where k.classid = n.classid and k.objid = n.objid and k.objsubid = n.objsubid))
)
select b.walk, t.type as target_type, t.identity as target, i.type, i.identity
from blockers b
  cross join lateral pg_identify_object(b.root_classid, b.root_objid, b.root_objsubid) t
  cross join lateral pg_identify_object(b.classid, b.objid, b.objsubid) i
order by 1, 2, 3, 4, 5`;

const VERBS: Readonly<Record<string, string>> = { drop: "drops", retype: "retypes" };

/**
 * Every object that blocks a drop or retype in `scans`, as a message, or `undefined` when none
 * does. Reads the Shadow, so it sees the Unmodeled objects verification would meet (ADR-0025).
 * It runs the `rename` scans first, so `shadow` is a transaction that rolls back.
 */
export async function unmodeledBlockers(
  shadow: Queryable,
  scans: readonly Scan[],
): Promise<string | undefined> {
  const objects = scans.flatMap((scan) =>
    scan.walk === "rename" ? [] : [{ walk: scan.walk, ...scan.object }],
  );
  if (objects.length === 0) return undefined;
  const renames = scans.flatMap((scan) => (scan.walk === "rename" ? [scan.sql] : []));
  if (renames.length > 0) await shadow.execute(renames.join("\n"));
  const { rows } = await shadow.query(BLOCKERS, [JSON.stringify(objects)]);
  if (rows.length === 0) return undefined;
  const targets = new Map<string, string[]>();
  for (const row of rows) {
    const target = `${String(row["target_type"])} ${String(row["target"])}, which it ${VERBS[String(row["walk"])]}`;
    const blockers = targets.get(target) ?? [];
    blockers.push(`${String(row["type"])} ${String(row["identity"])}`);
    targets.set(target, blockers);
  }
  const lines = [...targets].map(
    ([target, blockers]) =>
      `  ${target}:\n${blockers.map((blocker) => `    ${blocker}`).join("\n")}`,
  );
  return `Unmodeled objects block what the Current migration drops or retypes:\n${lines.join("\n")}\nGenerate never uses CASCADE or alters an Unmodeled object. Hand edit the Current migration to drop or change each one before the statement it blocks.`;
}
