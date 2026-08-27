// RFC-306 — end-to-end conditional branching through the real scheduler.
//
// What this file locks (each test names its AC):
//   AC-1/AC-2  a closed branch skips its whole downstream subgraph, the OTHER
//              branch runs normally, and the task still finishes `done`.
//   AC-3       GOLDEN LOCK: the identical workflow with no branch ports declared
//              behaves exactly as it did before RFC-306 (both chains run). This
//              is the test that fails if the feature ever starts inferring a
//              branch decision from something other than an explicit marker.
//   AC-4       a marker on an UNDECLARED port fails the node loudly rather than
//              silently running the branch the agent believed it had closed.
//   AC-5       joinMode: 'any' (default) merges, 'all' propagates the skip.
//   AC-9       a review node on a closed branch is skipped — no human is asked
//              to approve a document that was never produced.
//   AC-12      the relaxed T3 lifecycle invariant accepts a done task whose
//              output node is `skipped`.
//
// Shape used throughout: one judge agent with two branch ports, each feeding its
// own chain and its own output node. It is the smallest graph in which "the
// wrong branch ran" is observable rather than inferred.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runGit } from '../src/util/git'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

setDefaultTimeout(60_000)

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc306-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, '.seed'), 'seed\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  branchPorts?: string[],
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    // RFC-306: branchPorts rides frontmatter_extra, same sidecar path as
    // outputKinds — seeding it here exercises the real read (rowToAgent).
    frontmatterExtra: JSON.stringify(branchPorts === undefined ? {} : { branchPorts }),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const rows = await h.db.select({ id: agents.id, name: agents.name }).from(agents)
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  const canonical: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as Record<string, unknown>
      const id = typeof rec.agentName === 'string' ? byName.get(rec.agentName) : undefined
      return id === undefined ? node : ({ ...rec, agentId: id } as typeof node)
    }),
  }
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(canonical),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'rfc306',
    workflowId,
    workflowSnapshot: JSON.stringify(canonical),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({}),
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

/**
 * judge → { fix chain → output_fix, ok chain → output_ok }.
 *
 * `joinNode` optionally adds a merge node fed by BOTH chains, which is how the
 * joinMode cases observe partial activation.
 */
function twoBranchDefinition(opts: { joinMode?: 'any' | 'all' } = {}): WorkflowDefinition {
  const nodes: WorkflowDefinition['nodes'] = [
    { id: 'judge', kind: 'agent-single', agentName: 'judge' },
    { id: 'fixer', kind: 'agent-single', agentName: 'worker' },
    { id: 'greeter', kind: 'agent-single', agentName: 'worker' },
    {
      id: 'out_fix',
      kind: 'output',
      ports: [{ name: 'fix_result', bind: { nodeId: 'fixer', portName: 'summary' } }],
    },
    {
      id: 'out_ok',
      kind: 'output',
      ports: [{ name: 'ok_result', bind: { nodeId: 'greeter', portName: 'summary' } }],
    },
  ] as WorkflowDefinition['nodes']
  const edges: WorkflowDefinition['edges'] = [
    {
      id: 'e_fix',
      source: { nodeId: 'judge', portName: 'need_fix' },
      target: { nodeId: 'fixer', portName: 'findings' },
    },
    {
      id: 'e_ok',
      source: { nodeId: 'judge', portName: 'all_clear' },
      target: { nodeId: 'greeter', portName: 'note' },
    },
  ] as WorkflowDefinition['edges']
  if (opts.joinMode !== undefined) {
    nodes.push({
      id: 'merge',
      kind: 'agent-single',
      agentName: 'worker',
      joinMode: opts.joinMode,
    } as WorkflowDefinition['nodes'][number])
    edges.push(
      {
        id: 'e_m1',
        source: { nodeId: 'fixer', portName: 'summary' },
        target: { nodeId: 'merge', portName: 'from_fix' },
      } as WorkflowDefinition['edges'][number],
      {
        id: 'e_m2',
        source: { nodeId: 'greeter', portName: 'summary' },
        target: { nodeId: 'merge', portName: 'from_ok' },
      } as WorkflowDefinition['edges'][number],
    )
  }
  return { $schema_version: 1, inputs: [], nodes, edges }
}

/** Freshest TOP-LEVEL row per node → its status (rows come back unordered). */
async function statusByNode(db: DbClient, taskId: string): Promise<Map<string, string>> {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const freshest = new Map<string, { id: string; status: string }>()
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    const cur = freshest.get(r.nodeId)
    if (cur === undefined || r.id > cur.id) freshest.set(r.nodeId, r)
  }
  return new Map([...freshest].map(([k, v]) => [k, v.status]))
}

describe('RFC-306 — a closed branch skips its subgraph', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('AC-1/AC-2/AC-12: fix chain runs, ok chain is skipped, task is done', async () => {
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'], ['need_fix', 'all_clear'])
    await seedAgent(h.db, 'worker', ['summary'])
    const taskId = await seedTask(h, twoBranchDefinition())

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: '3 issues found', all_clear: 'code has issues, not releasing' },
          worker: { summary: 'worked' },
        }),
        MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['all_clear'] }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')

    const st = await statusByNode(h.db, taskId)
    expect(st.get('judge')).toBe('done')
    expect(st.get('fixer')).toBe('done')
    expect(st.get('out_fix')).toBe('done')
    // The closed branch: neither the agent nor its output node ran.
    expect(st.get('greeter')).toBe('skipped')
    expect(st.get('out_ok')).toBe('skipped')

    // The reason text is preserved on the port, and it is NOT data: the greeter
    // never ran, so nothing downstream ever received it.
    const judgeRun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === 'judge',
    )
    const ports = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, judgeRun?.id ?? ''))
    const allClear = ports.find((p) => p.portName === 'all_clear')
    expect(allClear?.active).toBe(false)
    expect(allClear?.content).toBe('code has issues, not releasing')
    expect(ports.find((p) => p.portName === 'need_fix')?.active).toBe(true)

    // AC-12: the relaxed T3 invariant accepts a skipped output node on a done
    // task. Before RFC-306 relaxed it, `out_ok` (skipped, no done row) would
    // have been reported as a violated invariant on a perfectly correct run.
    const inv = await runLifecycleInvariants({ db: h.db, scope: { taskId } })
    expect(inv.openAlerts.filter((a) => a.rule === 'T3')).toHaveLength(0)
  })

  test('AC-3 GOLDEN LOCK: no declared branch ports ⇒ both chains run, as before RFC-306', async () => {
    // Same graph, same agent outputs — the ONLY difference is that no port is
    // declared as a branch port, so the marker cannot be emitted and nothing is
    // ever skipped.
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'])
    await seedAgent(h.db, 'worker', ['summary'])
    const taskId = await seedTask(h, twoBranchDefinition())

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: '3 issues', all_clear: '' },
          worker: { summary: 'worked' },
        }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')
    const st = await statusByNode(h.db, taskId)
    // An EMPTY port is not a closed branch — the greeter still runs.
    expect(st.get('greeter')).toBe('done')
    expect(st.get('out_ok')).toBe('done')
    expect([...st.values()]).not.toContain('skipped')
  })

  test('AC-4: marking an UNDECLARED port fails the node instead of silently running the branch', async () => {
    // `all_clear` is a normal output here (not declared as a branch port), so the
    // marker is a protocol violation: the agent believes it closed a branch that
    // would otherwise run.
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'], ['need_fix'])
    await seedAgent(h.db, 'worker', ['summary'])
    const taskId = await seedTask(h, twoBranchDefinition())

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: 'x', all_clear: 'y' },
          worker: { summary: 'worked' },
        }),
        MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['all_clear'] }),
        // A same-session follow-up requires a resumable session id from the
        // prior attempt (`decideEnvelopeFollowup` refuses without one). Emitting
        // it here is what makes this fixture exercise the RE-ASK rather than a
        // plain fresh-session retry — and the re-ask wording is half of what
        // D4 promises for this failure.
        MOCK_OPENCODE_EMIT_SESSION_ID: '1',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const judgeRows = rows.filter((r) => r.nodeId === 'judge')
    expect(judgeRows.some((r) => r.failureCode === 'branch-port-not-declared')).toBe(true)

    // …and the re-ask must NAME the legal branch ports. The offending name the
    // agent already knows (it just wrote it); what it evidently does not know is
    // the legal set, so a correction round that omits it asks the model to guess.
    //
    // This assertion also guards a "both halves built, never connected" failure:
    // `branchMarkerDetail` is declared on the renderer input and consumed by the
    // renderer, so a missing PRODUCER at the runner call site is invisible to
    // every renderer-level test. Mutation-verified: deleting the runner's feed
    // turns this red while all the shared/prompt tests stay green.
    const followupPrompts = judgeRows.map((r) => r.promptText ?? '').filter((p) => p.length > 0)
    expect(
      followupPrompts.some((p) => p.includes('Declared branch ports on this agent: `need_fix`')),
    ).toBe(true)
  })
})

describe('RFC-306 — join semantics at a merge point', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test("AC-5: joinMode 'any' (default) runs the merge on one live branch", async () => {
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'], ['all_clear'])
    await seedAgent(h.db, 'worker', ['summary'])
    const taskId = await seedTask(h, twoBranchDefinition({ joinMode: 'any' }))

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: 'issues', all_clear: 'not clear' },
          worker: { summary: 'worked' },
        }),
        MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['all_clear'] }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const st = await statusByNode(h.db, taskId)
    expect(st.get('greeter')).toBe('skipped')
    expect(st.get('merge')).toBe('done') // one live leg is enough
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
  })

  test("AC-5: joinMode 'all' propagates the skip through the merge", async () => {
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'], ['all_clear'])
    await seedAgent(h.db, 'worker', ['summary'])
    const taskId = await seedTask(h, twoBranchDefinition({ joinMode: 'all' }))

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: 'issues', all_clear: 'not clear' },
          worker: { summary: 'worked' },
        }),
        MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['all_clear'] }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const st = await statusByNode(h.db, taskId)
    expect(st.get('fixer')).toBe('done')
    expect(st.get('greeter')).toBe('skipped')
    expect(st.get('merge')).toBe('skipped') // one dead leg is enough
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
  })
})

describe('RFC-306 — human gates on a closed branch', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('AC-9: a review node whose source branch is closed is skipped, not parked', async () => {
    await seedAgent(h.db, 'judge', ['need_fix', 'all_clear'], ['all_clear'])
    await seedAgent(h.db, 'worker', ['summary'])
    const def = twoBranchDefinition()
    // The review reads the greeter's output via `inputSource` — an IMPLICIT
    // dependency with no edge. Design-gate P1#2: judging activation on edges
    // alone would open this review on a branch that never ran.
    def.nodes.push({
      id: 'rev',
      kind: 'review',
      inputSource: { nodeId: 'greeter', portName: 'summary' },
    } as WorkflowDefinition['nodes'][number])
    const taskId = await seedTask(h, def)

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS_BY_AGENT: JSON.stringify({
          judge: { need_fix: 'issues', all_clear: 'not clear' },
          worker: { summary: 'worked' },
        }),
        MOCK_OPENCODE_INACTIVE_PORTS: JSON.stringify({ judge: ['all_clear'] }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const st = await statusByNode(h.db, taskId)
    expect(st.get('greeter')).toBe('skipped')
    expect(st.get('rev')).toBe('skipped')
    // The whole point: nobody is waiting on a human.
    expect([...st.values()]).not.toContain('awaiting_review')
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
  })
})
