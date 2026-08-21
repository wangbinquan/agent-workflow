import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { auditRfc295Downgrade, type Rfc295AuditTaskRow } from '../src/services/rfc295DowngradeAudit'
import { rfc295DowngradeAuditCommand } from '../src/cli/rfc295-downgrade-audit'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function codeHost(params: Record<string, string>): WorkflowNode {
  return {
    id: 'host',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.create',
    params: { mr: '42', body: 'hello', ...params },
  } as WorkflowNode
}

function workflow(node: WorkflowNode = codeHost({})): WorkflowDefinition {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [node],
    edges: [],
  }
}

function task(
  definition: WorkflowDefinition,
  extra: Partial<Rfc295AuditTaskRow> = {},
): Rfc295AuditTaskRow {
  return {
    id: 'task-1',
    workflowId: 'workflow-1',
    workflowVersion: 7,
    status: 'interrupted',
    workflowSnapshot: JSON.stringify(definition),
    refClosureJson: null,
    triggerContextJson: null,
    ...extra,
  }
}

describe('RFC-295 legacy projection downgrade audit', () => {
  test('pre-RFC-compatible resources and inactive literals pass', () => {
    const result = auditRfc295Downgrade({
      workflows: [
        {
          id: 'workflow-1',
          name: 'compatible',
          version: 3,
          definition: JSON.stringify(workflow(codeHost({ state: 'opened' }))),
        },
      ],
      tasks: [],
    })

    expect(result).toEqual({
      ok: true,
      scanned: { workflows: 1, tasks: 0, closureWorkflows: 0 },
      issues: [],
    })
  })

  test('forward-created local and generic trigger refs block downgrade without a frozen context', () => {
    const result = auditRfc295Downgrade({
      workflows: [
        {
          id: 'workflow-1',
          name: 'forward-created',
          version: 8,
          definition: JSON.stringify(
            workflow(
              codeHost({
                state: '{{trigger.webhook.event_type}}',
                orphan: '{{missing_port}}',
                invalid: '{{trigger.scheduler.fire_at}}',
              }),
            ),
          ),
        },
      ],
      tasks: [],
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((entry) => entry.code).sort()).toEqual([
      'legacy-local-ref-missing',
      'legacy-trigger-context-missing',
      'legacy-trigger-context-missing',
    ])
    expect(result.issues.every((entry) => entry.revision === 8)).toBe(true)
    expect(result.issues.every((entry) => entry.pointer.startsWith('/nodes/0/params/'))).toBe(true)
  })

  test('frozen trigger context is evaluated for task root and closure snapshots', () => {
    const inactiveTrigger = workflow(codeHost({ state: '{{trigger.webhook.event_type}}' }))
    const compatibleTask = task(inactiveTrigger, {
      triggerContextJson: JSON.stringify({ trigger: { webhook: { event_type: 'note' } } }),
    })
    const closureTask = task(workflow(), {
      id: 'task-closure',
      refClosureJson: JSON.stringify({
        closureVersion: 2,
        workflows: {
          'root#call': { id: 'child-workflow', version: 11, definition: inactiveTrigger },
        },
        workgroups: {},
      }),
    })

    const result = auditRfc295Downgrade({
      workflows: [],
      tasks: [compatibleTask, closureTask],
    })

    expect(result.scanned).toEqual({ workflows: 0, tasks: 2, closureWorkflows: 1 })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      code: 'legacy-trigger-context-missing',
      scope: 'task-closure',
      workflowId: 'child-workflow',
      revision: 11,
      taskId: 'task-closure',
    })
  })

  test('terminal non-resumable tasks are excluded and corrupt frozen closures fail closed', () => {
    const done = task(workflow(codeHost({ state: '{{trigger.webhook.event_type}}' })), {
      id: 'done-task',
      status: 'done',
    })
    const corrupt = task(workflow(), { id: 'live-task', refClosureJson: '{broken' })

    const result = auditRfc295Downgrade({ workflows: [], tasks: [done, corrupt] })

    expect(result.scanned.tasks).toBe(1)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'closure-invalid', taskId: 'live-task' }),
    ])
  })

  test('explicitly clearing inactive refs makes the same fixture downgrade-safe', () => {
    const before = auditRfc295Downgrade({
      workflows: [],
      tasks: [task(workflow(codeHost({ state: '{{trigger.webhook.event_type}}' })))],
    })
    const after = auditRfc295Downgrade({
      workflows: [],
      tasks: [task(workflow(codeHost({ state: '' })))],
    })

    expect(before.ok).toBe(false)
    expect(after.ok).toBe(true)
  })

  test('CLI scanner is read-only and returns a blocking, actionable report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc295-audit-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'db.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_version INTEGER,
        status TEXT NOT NULL,
        workflow_snapshot TEXT NOT NULL,
        ref_closure_json TEXT,
        trigger_context_json TEXT
      );
    `)
    db.query('INSERT INTO workflows (id, name, version, definition) VALUES (?, ?, ?, ?)').run(
      'workflow-1',
      'blocked',
      9,
      JSON.stringify(workflow(codeHost({ state: '{{trigger.webhook.event_type}}' }))),
    )
    db.close()

    const result = rfc295DowngradeAuditCommand(dbPath)

    expect(result.status).toBe('blocked')
    expect(result.output).toContain('RFC-295 downgrade audit: BLOCKED')
    expect(result.output).toContain('workflow=workflow-1 revision=9')
    expect(result.output).toContain('legacy-trigger-context-missing')

    const verify = new Database(dbPath, { readonly: true })
    expect(verify.query('SELECT COUNT(*) AS count FROM workflows').get()).toEqual({ count: 1 })
    verify.close()
  })
})
