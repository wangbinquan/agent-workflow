// RFC-354 D7 — a clarify gate is a row-backed node whose asker is its upstream.
//
// Before: `clarify` / `clarify-cross-agent` "settled without a row" — the
// frontier's pass-2 declared them complete once their upstreams were done and
// no session was open, and the `agent.__clarify__ → clarify` edge was carved
// out of the dependency graph ('unless-target-clarify') so the out-of-band
// gate never blocked anything. A task's history never showed the gate unless
// an agent asked.
//
// Now the gate is dispatched like any node and its `__clarify__` inbound edge
// is a real dependency (port table: `dataflow: 'always'`):
//   • the asker has not settled → the gate is not visited (nothing fires at t0,
//     so an agent's question mints the ONLY row — the `awaiting_human` park the
//     task waits on; that asked path stays locked by
//     scheduler-clarify-dispatch.test.ts);
//   • the asker was branch-skipped → the gate is judged like any downstream
//     node and settles as a `skipped` row (RFC-306 vocabulary);
//   • an unwired gate has no upstream → visited at once, nobody can ask, it
//     settles as a `skipped` row with reason `clarify-gate-idle`;
//   • a fresh `skipped` row completes the gate; a fresher park row parks it.
//
// The runtime cases below use the mock runtime's `MOCK_OPENCODE_INACTIVE_PORTS`
// (RFC-306) to close the branch feeding the asker — a WIRED asker that runs must
// ask on its first turn (RFC-100 mandatory ask-back), so "ran and never asked"
// is not a reachable idle path; "never ran" and "not wired" are.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { buildWorkflowScopeParentMap } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { deriveFrontier } from '../src/modules/task-execution/composition/dagFrontier'
import { buildScopeUpstreams } from '../src/modules/task-execution/composition/taskDagGraph'
import { runGit } from '../src/util/git'
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

type FrontierRow = Parameters<typeof deriveFrontier>[0][number]

function row(over: Partial<FrontierRow>): FrontierRow {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
    errorMessage: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    containerRunId: null,
    parentNodeRunId: null,
    ...over,
  } as unknown as FrontierRow
}

/** in1 → d; d.__clarify__ → c.questions; c.answers → d.__clarify_response__ */
const SELF_DEF: WorkflowDefinition = {
  $schema_version: 6,
  inputs: [{ kind: 'text', key: 'req', label: 'r' }],
  nodes: [
    { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
    { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
  ],
  edges: [
    {
      id: 'e_in',
      source: { nodeId: 'in1', portName: 'req' },
      target: { nodeId: 'd', portName: 'req' },
    },
    {
      id: 'e_ask',
      source: { nodeId: 'd', portName: '__clarify__' },
      target: { nodeId: 'c', portName: 'questions' },
    },
    {
      id: 'e_ans',
      source: { nodeId: 'c', portName: 'answers' },
      target: { nodeId: 'd', portName: '__clarify_response__' },
    },
  ],
}

/** SELF_DEF without the asking edge: a gate nobody can ask. */
const SELF_UNWIRED_DEF: WorkflowDefinition = {
  ...SELF_DEF,
  edges: SELF_DEF.edges.filter((e) => e.id !== 'e_ask'),
}

/** in1 → j; j.go → d.req (j closes `go`); d.__clarify__ → c; c.answers → d */
const SELF_BRANCH_DEF: WorkflowDefinition = {
  $schema_version: 6,
  inputs: [{ kind: 'text', key: 'req', label: 'r' }],
  nodes: [
    { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
    { id: 'j', kind: 'agent-single', agentName: 'judge' } as WorkflowNode,
    { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
  ],
  edges: [
    {
      id: 'e_in',
      source: { nodeId: 'in1', portName: 'req' },
      target: { nodeId: 'j', portName: 'req' },
    },
    {
      id: 'e_go',
      source: { nodeId: 'j', portName: 'go' },
      target: { nodeId: 'd', portName: 'req' },
    },
    {
      id: 'e_ask',
      source: { nodeId: 'd', portName: '__clarify__' },
      target: { nodeId: 'c', portName: 'questions' },
    },
    {
      id: 'e_ans',
      source: { nodeId: 'c', portName: 'answers' },
      target: { nodeId: 'd', portName: '__clarify_response__' },
    },
  ],
}

/** in1 → designer.design → questioner; questioner.__clarify__ → cross1 → both */
const CROSS_DEF: WorkflowDefinition = {
  $schema_version: 6,
  inputs: [{ kind: 'text', key: 'topic', label: 'topic', required: true }],
  nodes: [
    { id: 'in1', kind: 'input', inputKey: 'topic' },
    { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
    { id: 'cross1', kind: 'clarify-cross-agent' },
  ] as unknown as WorkflowDefinition['nodes'],
  edges: [
    {
      id: 'e_in_d',
      source: { nodeId: 'in1', portName: 'topic' },
      target: { nodeId: 'designer', portName: 'topic' },
    },
    {
      id: 'e_d_q',
      source: { nodeId: 'designer', portName: 'design' },
      target: { nodeId: 'questioner', portName: 'design' },
    },
    {
      id: 'e_q_cross',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'cross1', portName: 'questions' },
    },
    {
      id: 'e_cross_to_q',
      source: { nodeId: 'cross1', portName: 'to_questioner' },
      target: { nodeId: 'questioner', portName: '__clarify_response__' },
    },
    {
      id: 'e_cross_to_d',
      source: { nodeId: 'cross1', portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    },
  ],
}

const TOP = { containerRunId: null, iteration: 0 }

function frontierOf(
  definition: WorkflowDefinition,
  rows: FrontierRow[],
  openClarify: ReadonlySet<string> = new Set(),
) {
  const scopeIds = new Set(definition.nodes.map((n) => n.id))
  const upstreamsOf = buildScopeUpstreams(
    definition,
    scopeIds,
    null,
    buildWorkflowScopeParentMap(definition),
  )
  return {
    upstreamsOf,
    frontier: deriveFrontier(
      rows,
      definition,
      definition.nodes,
      scopeIds,
      TOP,
      upstreamsOf,
      new Set(),
      new Set(),
      openClarify,
    ),
  }
}

describe('RFC-354 D7 — frontier: the asker is the gate’s structural upstream', () => {
  const in1Done = row({ id: '01A', nodeId: 'in1', consumedUpstreamRunsJson: '{}' })

  test('the __clarify__ edge is a dependency: no asker row → the gate is neither ready nor completed', () => {
    const { upstreamsOf, frontier } = frontierOf(SELF_DEF, [])
    expect(upstreamsOf.get('c')).toEqual(['d'])
    expect(frontier.completed.has('c')).toBe(false)
    expect(frontier.ready).not.toContain('c')
    expect(frontier.ready).toContain('in1')
  })

  test('asker done → the gate is READY (dispatched like any node), never silently completed', () => {
    const dDone = row({ id: '01B', nodeId: 'd', consumedUpstreamRunsJson: '{"in1":"01A"}' })
    const { frontier } = frontierOf(SELF_DEF, [in1Done, dDone])
    expect(frontier.completed.has('d')).toBe(true)
    expect(frontier.completed.has('c')).toBe(false)
    expect(frontier.ready).toContain('c')
  })

  test('asker branch-skipped → the gate is READY too (the gateway then judges it inactive)', () => {
    const dSkipped = row({
      id: '01B',
      nodeId: 'd',
      status: 'skipped',
      consumedUpstreamRunsJson: '{"in1":"01A"}',
    })
    const { frontier } = frontierOf(SELF_DEF, [in1Done, dSkipped])
    expect(frontier.completed.has('d')).toBe(true)
    expect(frontier.ready).toContain('c')
  })

  test('an unwired gate has no upstream → ready at t0', () => {
    const { upstreamsOf, frontier } = frontierOf(SELF_UNWIRED_DEF, [])
    expect(upstreamsOf.get('c')).toEqual([])
    expect(frontier.ready).toContain('c')
  })

  test('a fresh skipped row completes the gate; a fresher park row + open session parks it', () => {
    const dDone = row({ id: '01B', nodeId: 'd', consumedUpstreamRunsJson: '{"in1":"01A"}' })
    const skipped = row({
      id: '01C', // older than the park row below (ULID order = freshness)
      nodeId: 'c',
      status: 'skipped',
      consumedUpstreamRunsJson: '{"d":"01B"}',
    })
    const { frontier: f } = frontierOf(SELF_DEF, [in1Done, dDone, skipped])
    expect(f.completed.has('c')).toBe(true)
    expect(f.allSettled).toBe(true)

    const parked = row({ id: '01D', nodeId: 'c', status: 'awaiting_human' })
    const { frontier: g } = frontierOf(SELF_DEF, [in1Done, dDone, skipped, parked], new Set(['c']))
    expect(g.completed.has('c')).toBe(false)
    expect(g.ready).not.toContain('c')
    expect(g.awaitingHuman).toContain('c')
  })
})

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc354-clarify-idle-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  for (const dir of [repoPath, worktreePath]) {
    await runGit(dir, ['init', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    writeFileSync(join(dir, 'README.md'), '# r\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-m', 'init'])
  }
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  branchPorts: string[] = [],
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    // RFC-306: only a declared branch port may be closed with active="false"
    // (the runner rejects `branch-port-not-declared` otherwise); the catalog
    // keeps the declaration in the frontmatter sidecar.
    frontmatterExtra: JSON.stringify(branchPorts.length > 0 ? { branchPorts } : {}),
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string>,
): Promise<string> {
  const canonical = await canonicalizeWorkflowAgentIds(h.db, definition)
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(canonical),
  })
  await h.db.insert(tasks).values({
    name: 'rfc354-clarify-idle',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonical),
    repoPath: h.repoPath,
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

describe('RFC-354 D7 — runtime: an untriggered clarify gate settles as one skipped row', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  async function run(taskId: string, env: Record<string, string>): Promise<void> {
    await withEnv(env, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        sessionRestartBudget: 0,
      }),
    )
  }

  async function statusByNode(taskId: string): Promise<Map<string, string[]>> {
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const out = new Map<string, string[]>()
    for (const r of runs.sort((a, b) => a.id.localeCompare(b.id))) {
      out.set(r.nodeId, [...(out.get(r.nodeId) ?? []), r.status])
    }
    return out
  }

  test('unwired self gate: nobody can ask → one skipped row (clarify-gate-idle), task done', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const taskId = await seedWorkflowAndTask(h, SELF_UNWIRED_DEF, { req: 'pick' })
    await run(taskId, { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'D' }) })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const byNode = await statusByNode(taskId)
    expect(byNode.get('d')).toEqual(['done'])
    expect(byNode.get('c')).toEqual(['skipped'])
    // Same row shape as an RFC-306 branch skip: minted `pending` with the
    // `branch-skip` cause and settled through `mark-skipped` (no error).
    const gate = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === 'c',
    )
    expect(gate?.rerunCause).toBe('branch-skip')
    expect(gate?.errorMessage).toBeNull()
  }, 20_000)

  test('self gate behind a closed branch: the asker never runs → gate skipped with it, task done', async () => {
    await seedAgent(h.db, 'judge', ['go'], ['go'])
    await seedAgent(h.db, 'designer', ['design'])
    const taskId = await seedWorkflowAndTask(h, SELF_BRANCH_DEF, { req: 'pick' })
    await run(taskId, {
      MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
        judge: { go: 'not today' },
        designer: { design: 'D' },
      }),
      MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['go'] }),
    })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const byNode = await statusByNode(taskId)
    expect(byNode.get('j')).toEqual(['done'])
    expect(byNode.get('d')).toEqual(['skipped'])
    expect(byNode.get('c')).toEqual(['skipped'])
  }, 20_000)

  test('cross gate behind a closed branch: the questioner never runs → cross gate skipped, no designer rerun', async () => {
    await seedAgent(h.db, 'designer', ['design'], ['design'])
    await seedAgent(h.db, 'questioner', ['summary'])
    const taskId = await seedWorkflowAndTask(h, CROSS_DEF, { topic: 't' })
    await run(taskId, {
      MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
        designer: { design: 'D' },
        questioner: { summary: 'S' },
      }),
      MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ designer: ['design'] }),
    })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const byNode = await statusByNode(taskId)
    expect(byNode.get('designer')).toEqual(['done'])
    expect(byNode.get('questioner')).toEqual(['skipped'])
    expect(byNode.get('cross1')).toEqual(['skipped'])
  }, 20_000)
})
