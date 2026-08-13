// Read-only RFC-295 downgrade preflight. This command deliberately opens the
// database without migrations and has no force/ignore switch.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { Paths } from '@/util/paths'
import {
  RFC295_DOWNGRADE_AUDIT_TASK_STATUSES,
  auditRfc295Downgrade,
  type Rfc295AuditTaskRow,
  type Rfc295AuditWorkflowRow,
  type Rfc295DowngradeAuditResult,
} from '@/services/rfc295DowngradeAudit'

export interface Rfc295DowngradeAuditCommandResult {
  readonly status: 'ok' | 'blocked' | 'error'
  readonly output: string
  readonly audit?: Rfc295DowngradeAuditResult
}

function formatIssue(issue: Rfc295DowngradeAuditResult['issues'][number]): string {
  const revision = issue.revision === null ? '?' : String(issue.revision)
  const task = issue.taskId === null ? '' : ` task=${issue.taskId}`
  const node = issue.nodeId === null ? '' : ` node=${issue.nodeId}`
  const ref = issue.ref === null ? '' : ` ref={{${issue.ref}}}`
  return `- ${issue.code} workflow=${issue.workflowId} revision=${revision}${task}${node} pointer=${issue.pointer}${ref}: ${issue.detail}`
}

export function formatRfc295DowngradeAudit(audit: Rfc295DowngradeAuditResult): string {
  const summary =
    `RFC-295 downgrade audit: ${audit.ok ? 'OK' : 'BLOCKED'}; ` +
    `scanned ${audit.scanned.workflows} workflow(s), ${audit.scanned.tasks} live/resumable task(s), ` +
    `${audit.scanned.closureWorkflows} frozen closure workflow(s)`
  if (audit.ok) return `${summary}\n`
  return `${summary}\n${audit.issues.map(formatIssue).join('\n')}\n`
}

export function rfc295DowngradeAuditCommand(
  dbPath: string = Paths.db,
): Rfc295DowngradeAuditCommandResult {
  if (!existsSync(dbPath)) {
    const audit = auditRfc295Downgrade({ workflows: [], tasks: [] })
    return { status: 'ok', audit, output: `${formatRfc295DowngradeAudit(audit)}(no database)\n` }
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.exec('PRAGMA busy_timeout = 5000;')
    const workflows = db
      .query('SELECT id, name, version, definition FROM workflows ORDER BY id')
      .all() as Rfc295AuditWorkflowRow[]
    const statuses = RFC295_DOWNGRADE_AUDIT_TASK_STATUSES.map((status) => `'${status}'`).join(',')
    const tasks = db
      .query(
        `SELECT id, workflow_id AS workflowId, workflow_version AS workflowVersion, status, ` +
          `workflow_snapshot AS workflowSnapshot, ref_closure_json AS refClosureJson, ` +
          `trigger_context_json AS triggerContextJson FROM tasks ` +
          `WHERE status IN (${statuses}) ORDER BY id`,
      )
      .all() as Rfc295AuditTaskRow[]
    const audit = auditRfc295Downgrade({ workflows, tasks })
    return {
      status: audit.ok ? 'ok' : 'blocked',
      audit,
      output: formatRfc295DowngradeAudit(audit),
    }
  } catch (error) {
    return {
      status: 'error',
      output: `RFC-295 downgrade audit: ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
    }
  } finally {
    db?.close()
  }
}
