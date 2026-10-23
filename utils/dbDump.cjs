// utils/dbDump.cjs
// Full logical backup of the Neon database as ONE plain .sql file — schema
// (tables, defaults, constraints, indexes, sequences, functions, triggers, RLS
// policies) followed by every row of every table in `public`.
//
// Why not pg_dump: neither the dev machine nor Render ships the binaries, and
// pg_dump must also match Neon's major version. This reads pg_catalog through
// the same `pg` pool the server already uses, inside a READ ONLY REPEATABLE
// READ transaction, so the file is one consistent snapshot and can never write.
//
// Every value is selected as ::text and written back as a quoted literal, which
// Postgres casts to the column type on INSERT — json, arrays, bytea, timestamps
// and numerics all round-trip without per-type code.
//
// Restore into an EMPTY database:  psql "<new db url>" -f neon-full-<stamp>.sql
//
// Used by backup-neon.cjs (CLI, writes a local file) and by
// GET /api/admin/db-dump (super-admin download button).

const BATCH = 500;

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Stream a full dump into `write(chunk)` (sync or async). Returns a summary.
 * @param {import("pg").Pool} pool
 * @param {(s: string) => any} write
 */
async function dumpDatabase(pool, write) {
  const client = await pool.connect();
  const summary = { tables: [], totalRows: 0, startedAt: new Date().toISOString() };
  const out = async (s) => { await write(s); };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const info = (await client.query("select version() v, current_database() db")).rows[0];

    await out(
      `-- Full database backup (schema + data)\n` +
      `-- Database: ${info.db}\n-- Server:   ${info.v}\n-- Taken:    ${summary.startedAt}\n` +
      `-- Restore into an EMPTY database:  psql "<db url>" -f <this file>\n\n` +
      `SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n` +
      `SET check_function_bodies = false;\nSET session_replication_role = replica; -- skip FK/trigger checks while loading\n\n` +
      `BEGIN;\n\n`
    );

    /* ── Extensions (pgcrypto: db/schema.cjs creates it; plpgsql is built in) ── */
    const exts = (await client.query(`
      select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace
       where e.extname<>'plpgsql' order by 1`)).rows;
    for (const e of exts) await out(`CREATE EXTENSION IF NOT EXISTS ${q(e.extname)} WITH SCHEMA ${q(e.nspname)};\n`);
    if (exts.length) await out(`\n`);

    /* ── Sequences (created first; owned-by + setval after the data) ── */
    const seqs = (await client.query(`
      select s.relname name, ps.data_type, ps.start_value, ps.increment_by, ps.min_value, ps.max_value,
             ps.cycle, ps.last_value
        from pg_class s join pg_sequences ps on ps.schemaname='public' and ps.sequencename=s.relname
        join pg_namespace n on n.oid=s.relnamespace
       where s.relkind='S' and n.nspname='public' order by 1`)).rows;
    if (seqs.length) await out(`-- ═════ Sequences ═════\n`);
    for (const s of seqs) {
      await out(`CREATE SEQUENCE IF NOT EXISTS public.${q(s.name)} AS ${s.data_type} START ${s.start_value} ` +
        `INCREMENT ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value}${s.cycle ? " CYCLE" : ""};\n`);
    }

    /* ── Functions (RLS helpers, triggers) ── */
    const fns = (await client.query(`
      select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prokind in ('f','p')
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
       order by p.proname`)).rows;
    if (fns.length) await out(`\n-- ═════ Functions ═════\n`);
    for (const f of fns) await out(`${f.def};\n\n`);

    /* ── Tables ── */
    const tables = (await client.query(`
      select c.oid, c.relname name, c.relrowsecurity rls, c.relforcerowsecurity force_rls
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where c.relkind in ('r','p') and n.nspname='public'
         and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
       order by c.relname`)).rows;

    await out(`\n-- ═════ Tables ═════\n`);
    for (const t of tables) {
      const cols = (await client.query(`
        select a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attnotnull notnull,
               pg_get_expr(d.adbin, d.adrelid) def, a.attidentity ident, a.attgenerated gen
          from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
         where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [t.oid])).rows;
      t.cols = cols;
      const lines = cols.map((c) => {
        let l = `  ${q(c.name)} ${c.type}`;
        if (c.gen === "s") l += ` GENERATED ALWAYS AS (${c.def}) STORED`;
        else if (c.ident) l += ` GENERATED ${c.ident === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
        else if (c.def != null) l += ` DEFAULT ${c.def}`;
        if (c.notnull) l += " NOT NULL";
        return l;
      });
      await out(`CREATE TABLE public.${q(t.name)} (\n${lines.join(",\n")}\n);\n`);
    }

    /* ── Data ── */
    await out(`\n-- ═════ Data ═════\n`);
    for (const t of tables) {
      const cols = t.cols.filter((c) => c.gen !== "s");
      if (!cols.length) continue;
      const colList = cols.map((c) => q(c.name)).join(", ");
      const sel = cols.map((c) => `${q(c.name)}::text`).join(", ");
      const ov = cols.some((c) => c.ident === "a") ? " OVERRIDING SYSTEM VALUE" : "";
      await out(`\n-- ${t.name}\n`);
      /* Paged, so `reports` (60+ MB of JSON) never sits in memory at once —
         this also runs on Render. ctid order is stable inside the snapshot. */
      let n = 0;
      for (;;) {
        const { rows } = await client.query({
          text: `select ${sel} from public.${q(t.name)} order by ctid limit ${BATCH} offset ${n}`,
          rowMode: "array",
        });
        if (!rows.length) break;
        n += rows.length;
        const chunk = rows.map((r) => `(${r.map(lit).join(", ")})`).join(",\n");
        await out(`INSERT INTO public.${q(t.name)} (${colList})${ov} VALUES\n${chunk};\n`);
        if (rows.length < BATCH) break;
      }
      summary.tables.push({ table: t.name, rows: n });
      summary.totalRows += n;
      await out(`-- ${t.name}: ${n} rows\n`);
    }

    /* ── Constraints (PK/unique/check first, foreign keys last) ── */
    const cons = (await client.query(`
      select c.conrelid::regclass::text tbl, c.conname name, pg_get_constraintdef(c.oid) def, c.contype
        from pg_constraint c join pg_namespace n on n.oid=c.connamespace
       where n.nspname='public' and c.contype in ('p','u','c','f','x') and c.conrelid<>0
       order by (c.contype='f'), 1, 2`)).rows;
    if (cons.length) await out(`\n-- ═════ Constraints ═════\n`);
    for (const c of cons) await out(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${q(c.name)} ${c.def};\n`);

    /* ── Indexes not already created by a constraint ── */
    const idx = (await client.query(`
      select pg_get_indexdef(i.indexrelid) def from pg_index i
        join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public'
         and not exists (select 1 from pg_constraint k where k.conindid=i.indexrelid)
       order by 1`)).rows;
    if (idx.length) await out(`\n-- ═════ Indexes ═════\n`);
    for (const i of idx) await out(`${i.def};\n`);

    /* ── Sequence ownership + current values ── */
    const owned = (await client.query(`
      select s.relname seq, t.relname tbl, a.attname col
        from pg_depend d join pg_class s on s.oid=d.objid and s.relkind='S'
        join pg_class t on t.oid=d.refobjid join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
        join pg_namespace n on n.oid=s.relnamespace
       where n.nspname='public' and d.deptype='a'`)).rows;
    if (seqs.length) await out(`\n-- ═════ Sequence values ═════\n`);
    for (const o of owned) await out(`ALTER SEQUENCE public.${q(o.seq)} OWNED BY public.${q(o.tbl)}.${q(o.col)};\n`);
    for (const s of seqs) {
      if (s.last_value != null) await out(`SELECT setval('public.${q(s.name)}', ${s.last_value}, true);\n`);
    }

    /* ── Triggers ── */
    const trg = (await client.query(`
      select pg_get_triggerdef(t.oid) def from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1`)).rows;
    if (trg.length) await out(`\n-- ═════ Triggers ═════\n`);
    for (const t of trg) await out(`${t.def};\n`);

    /* ── Row-level security (tenant isolation) ── */
    const pols = (await client.query(`
      select tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_policies where schemaname='public' order by 1, 2`)).rows;
    const rlsTables = tables.filter((t) => t.rls || t.force_rls);
    if (rlsTables.length || pols.length) await out(`\n-- ═════ Row-level security ═════\n`);
    for (const t of rlsTables) {
      if (t.rls) await out(`ALTER TABLE public.${q(t.name)} ENABLE ROW LEVEL SECURITY;\n`);
      if (t.force_rls) await out(`ALTER TABLE public.${q(t.name)} FORCE ROW LEVEL SECURITY;\n`);
    }
    /* The roles the policies name (app_tenant) and their grants — a fresh
       database has neither, and without them the restored policies point at
       nothing. Roles are global, so CREATE only when missing. */
    const polRoles = [...new Set(pols.flatMap((p) =>
      (Array.isArray(p.roles) ? p.roles : String(p.roles || "").replace(/[{}]/g, "").split(","))
        .filter((r) => r && r !== "public")))];
    for (const r of polRoles) {
      await out(`DO $do$ BEGIN CREATE ROLE ${q(r)} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $do$;\n`);
      await out(`GRANT USAGE ON SCHEMA public TO ${q(r)};\n`);
      const g = (await client.query(`
        select table_name, string_agg(privilege_type, ', ' order by privilege_type) privs
          from information_schema.role_table_grants
         where table_schema='public' and grantee=$1 group by 1 order by 1`, [r])).rows;
      for (const x of g) await out(`GRANT ${x.privs} ON public.${q(x.table_name)} TO ${q(r)};\n`);
      const sg = (await client.query(`
        select object_name from information_schema.role_usage_grants
         where object_schema='public' and object_type='SEQUENCE' and grantee=$1 order by 1`, [r])).rows;
      for (const x of sg) await out(`GRANT USAGE, SELECT ON SEQUENCE public.${q(x.object_name)} TO ${q(r)};\n`);
      // The server connects as the owner and switches with SET ROLE (TENANT_RLS),
      // which needs membership; whoever runs the restore becomes that owner.
      await out(`GRANT ${q(r)} TO CURRENT_USER;\n`);
    }
    /* Default privileges: tables/sequences the server creates AFTER a restore
       must still reach app_tenant, or tenant mode breaks on the next new table. */
    const PRIV = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", U: "USAGE", m: "MAINTAIN" };
    const defacl = (await client.query(`
      select defaclobjtype t, defaclacl::text[] acl from pg_default_acl where defaclrole = (select oid from pg_roles where rolname=current_user)`)).rows;
    for (const d of defacl) {
      const kind = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES" }[d.t];
      for (const item of d.acl || []) {
        const m = String(item).match(/^"?([^"=]*)"?=([a-zA-Z*]*)\//);
        if (!kind || !m || !polRoles.includes(m[1])) continue;
        const privs = [...new Set(m[2].replace(/\*/g, "").split("").map((c) => PRIV[c]).filter(Boolean))];
        if (privs.length) await out(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privs.join(", ")} ON ${kind} TO ${q(m[1])};\n`);
      }
    }
    for (const p of pols) {
      const roles = (Array.isArray(p.roles) ? p.roles : String(p.roles || "").replace(/[{}]/g, "").split(","))
        .filter(Boolean).map((r) => (r === "public" ? "PUBLIC" : q(r))).join(", ") || "PUBLIC";
      await out(`CREATE POLICY ${q(p.policyname)} ON public.${q(p.tablename)} AS ${p.permissive} FOR ${p.cmd} TO ${roles}` +
        `${p.qual ? ` USING (${p.qual})` : ""}${p.with_check ? ` WITH CHECK (${p.with_check})` : ""};\n`);
    }

    await out(`\nCOMMIT;\nSET session_replication_role = origin;\n-- end of backup: ${summary.tables.length} tables, ${summary.totalRows} rows\n`);
    await client.query("ROLLBACK");
    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { dumpDatabase };
