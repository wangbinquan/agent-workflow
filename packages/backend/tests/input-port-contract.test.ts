// RFC-004 regression: an input node's output port name MUST equal its
// `inputKey`, and the value routed to that port MUST be `task.inputs[inputKey]`.
// If this goes red, check scheduler.ts:319 and workflow.validator.ts around
// the input-key-not-declared block in lock-step — they encode the same
// contract from opposite ends (runtime vs static).
//
// Origin: failed task 01KRNJXKNSXR8C1DHSCCCWHDD4 (2026-05-15) — the workflow's
// edge had source.portName='requirement' but the scheduler hardcoded the port
// to 'out', so resolveUpstreamInputs found nothing and the agent received an
// empty `## requirement` section.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc004-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('RFC-004 input-port contract', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('input.requirement → agent.requirement delivers the launcher value', async () => {
    await seedAgent(h.db, 'coder', ['answer'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'Need', required: true }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        { id: 'a1', kind: 'agent-single', agentName: 'coder' },
      ],
      // Edge mirrors what the canvas produces today: source port name === inputKey.
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'a1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'build a login page' })

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ answer: 'done' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).toBe('done')
    expect(finalTask?.errorMessage).toBeNull()

    // 1. The input node's persisted output row is keyed by inputKey, not 'out'.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const inRun = runs.find((r) => r.nodeId === 'in')
    const inOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, inRun?.id ?? ''))
    expect(inOutputs.find((o) => o.portName === 'requirement')?.content).toBe('build a login page')
    expect(inOutputs.find((o) => o.portName === 'out')).toBeUndefined()

    // 2. The agent run actually received that value in its prompt.
    const a1Run = runs.find((r) => r.nodeId === 'a1')
    expect(a1Run?.promptText ?? '').toContain('build a login page')
  })
})
