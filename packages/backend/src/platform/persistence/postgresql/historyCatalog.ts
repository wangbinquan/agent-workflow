import type { HistoryConnection } from '../schema/history/connection'
import { sortHistoryCatalog as sorted, type HistoryCatalog } from '../schema/history/catalogModel'
export async function collectPostgresqlHistoryCatalog(
  connection: HistoryConnection,
): Promise<HistoryCatalog> {
  const rows = await connection.execute(`
    SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS relation, c.relname AS name,
      c.relkind::text AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') AND c.relkind IN ('r','v','m','p')
    UNION ALL
    SELECT 'column',n.nspname || '.' || c.relname,a.attname,
      (row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum))::text || '|' || format_type(a.atttypid,a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' || coalesce(pg_get_expr(d.adbin,d.adrelid),'') || '|' || coalesce(co.collname,'')
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation
      WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint',n.nspname || '.' || c.relname,con.conname,pg_get_constraintdef(con.oid,true) || '|' || con.convalidated::text
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'index',schemaname || '.' || tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'sequence',schemaname || '.' || sequencename,sequencename,data_type || '|' || start_value || '|' || min_value || '|' || max_value || '|' || increment_by || '|' || cycle FROM pg_sequences WHERE schemaname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'function',n.nspname,p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'trigger',n.nspname || '.' || c.relname,t.tgname,pg_get_triggerdef(t.oid,true) || '|' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') AND NOT t.tgisinternal`)
  return sorted(
    rows.map((row) => ({
      kind: String(row.kind),
      relation: String(row.relation),
      name: String(row.name),
      definition: String(row.definition),
    })),
  )
}
