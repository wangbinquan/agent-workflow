// REGRESSION LOCK: a validator-accepted same-iteration DATA cycle between two
// agents inside a wrapper-loop must NOT degrade into an opaque "scheduler
// stalled" failure at runtime.
//
// DEFECT (HIGH, fix-direction open):
//   The validator deliberately EXEMPTS back-edges whose endpoints share the
//   same loop wrapper from the DAG check:
//     packages/backend/src/services/workflow.validator.ts:417
//       `if (lFrom !== undefined && lFrom === lTo) continue`
//   So `validateWorkflowDef` returns NO topology-cycle issue for an inner data
//   cycle. But the scheduler only cycle-checks the TOP-LEVEL scope:
//     packages/backend/src/services/scheduler.ts:317  topologicalOrder(...)
//   Inner (loop) scopes run via deriveFrontier and are NEVER cycle-checked. A
//   genuine same-iteration data cycle n1 -> n2 -> n1 makes
//   areTransitiveUpstreamsCompleted() return false for BOTH nodes forever, the
//   inner scope goes quiescent with `allSettled === false`, and the quiescent
//   branch reports the catch-all:
//     packages/backend/src/services/scheduler.ts:624-630
//       { summary: 'scheduler stalled', message: 'no ready nodes in scope' }
//   The user gets an opaque stall for a graph the validator called valid.
//
// CORRECT (post-fix) behavior: the intra-loop cycle must surface as a CLEAR
// cycle error (or be rejected upstream by the validator) — never the opaque
// "scheduler stalled". The chosen fix may be either:
//   (a) validator rejection of same-iteration data cycles inside a loop, OR
//   (b) runtime cycle detection in inner scopes with a cycle-specific error.
// Either way, the opaque stall IS the defect; this test locks against it.
//
// RED until that fix lands. Today task.errorSummary === 'scheduler stalled',
// so the headline assertion below FAILS for exactly the right reason.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { agents } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { validateWorkflowDef } from '../src/services/workflow.validator'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-intraloopcycle-'))
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
async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
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
    name: 'fixture-task',
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

describe('scheduler: intra-loop same-iteration data cycle must not stall opaquely (RED until cycle is rejected/detected)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  function cyclicLoopDef(): WorkflowDefinition {
    return {
      $schema_version: 1,
      nodes: [
        { id: 'n1', kind: 'agent-single', agentName: 'a1' },
        { id: 'n2', kind: 'agent-single', agentName: 'a2' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['n1', 'n2'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'n1', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'n1', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        // plain DATA edges -> kept by buildScopeUpstreams -> cycle in the inner scope
        {
          id: 'c1',
          source: { nodeId: 'n1', portName: 'findings' },
          target: { nodeId: 'n2', portName: 'input' },
        },
        {
          id: 'c2',
          source: { nodeId: 'n2', portName: 'findings' },
          target: { nodeId: 'n1', portName: 'input' },
        },
      ] as unknown as WorkflowDefinition['edges'],
    } as unknown as WorkflowDefinition
  }

  test('an n1<->n2 data cycle inside a loop surfaces a clear error, not "scheduler stalled"', async () => {
    await seedAgent(h.db, 'a1', ['findings'])
    await seedAgent(h.db, 'a2', ['findings'])

    const def = cyclicLoopDef()
    const taskId = await seedWorkflowAndTask(h, def, {})

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'x' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const [task] = await h.db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(task).toBeDefined()

    // HEADLINE (post-fix expectation): the failure, whatever its shape, must NOT
    // be the opaque catch-all stall. Today errorSummary === 'scheduler stalled'
    // (scheduler.ts:624-630) so this FAILS for exactly the right reason.
    expect(task!.errorSummary ?? '').not.toContain('stalled')
  }, 120_000)
})

describe('validateWorkflowDef surfaces an intra-loop data cycle as a warning (clarify exemption preserved)', () => {
  const loopWith = (edges: WorkflowDefinition['edges']): WorkflowDefinition =>
    ({
      $schema_version: 1,
      nodes: [
        { id: 'n1', kind: 'agent-single', agentName: 'a1' },
        { id: 'n2', kind: 'agent-single', agentName: 'a2' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['n1', 'n2'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'n1', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'n1', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges,
    }) as unknown as WorkflowDefinition

  test('cyclic loop → wrapper-loop-inner-data-cycle WARNING, but NOT a hard topology-cycle', () => {
    const def = loopWith([
      {
        id: 'c1',
        source: { nodeId: 'n1', portName: 'findings' },
        target: { nodeId: 'n2', portName: 'input' },
      },
      {
        id: 'c2',
        source: { nodeId: 'n2', portName: 'findings' },
        target: { nodeId: 'n1', portName: 'input' },
      },
    ] as unknown as WorkflowDefinition['edges'])

    const { issues } = validateWorkflowDef(def, { agents: [], skills: [] })
    // Item 2: a pure agent→agent data cycle inside a loop deadlocks at runtime
    // (no cross-iteration ports in v1), so it is surfaced at edit time as a
    // non-blocking WARNING.
    const dataCycle = issues.find((i) => i.code === 'wrapper-loop-inner-data-cycle')
    expect(dataCycle).toBeDefined()
    expect(dataCycle?.severity).toBe('warning')
    // The long-standing topology exemption for in-loop feedback cycles is
    // preserved (no hard 'topology-cycle' error); the runtime findScopeCycle is
    // the hard backstop. See the runtime test above.
    expect(issues.some((i) => i.code === 'topology-cycle')).toBe(false)
  })

  test('healthy loop (no back-edge) is NOT flagged', () => {
    const def = loopWith([
      {
        id: 'c1',
        source: { nodeId: 'n1', portName: 'findings' },
        target: { nodeId: 'n2', portName: 'input' },
      },
    ] as unknown as WorkflowDefinition['edges'])

    const { issues } = validateWorkflowDef(def, { agents: [], skills: [] })
    expect(issues.some((i) => i.code === 'wrapper-loop-inner-data-cycle')).toBe(false)
  })
})
