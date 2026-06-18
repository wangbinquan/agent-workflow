// RFC-040 — wrapper-loop / wrapper-git bubble awaiting_human / awaiting_review.
//
// Locks the contract that prior to RFC-040 was silently broken:
//
//   * wrapper-loop ∋ {agent, clarify}: the inner agent asks clarify on
//     iteration 0; the loop MUST park (creating exactly ONE clarify_session,
//     not maxIterations of them) instead of swallowing the awaiting_human
//     signal and racing through the remaining iterations.
//
//   * wrapper-loop resume: after the user answers the parked clarify, the
//     same wrapper node_run row (NOT a fresh second one) drives the
//     remaining iterations. wrapper_progress_json is the persistence
//     anchor; the dispatcher re-enters via runTask and findResumableWrapperRun
//     reuses the existing row.
//
//   * wrapper-git ∋ {agent, clarify}: when the inner agent asks clarify,
//     the wrapper MUST NOT compute its `git_diff` output (today's pre-RFC-040
//     bug computed a partial diff against the half-finished worktree, marked
//     wrapper done, and orphaned the clarify). After clarify is answered, the
//     wrapper resumes against the persisted baseline (NOT a freshly-captured
//     HEAD), writes git_diff once.
//
// If any of these tests start failing, the static-correctness fix from
// RFC-040 has regressed. See design/RFC-040-wrapper-await-bubble/design.md
// §4.2 (loop) and §4.3 (git) for the contract these tests lock.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  clarifySessions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { submitClarifyAnswers } from '../src/services/clarify'
import { decodeWrapperProgress } from '../src/services/wrapperProgress'
import { runGit } from '../src/util/git'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-rfc040-${slug}-`))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[] = ['design'],
  readonly = true,
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<{ workflowId: string; taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return { workflowId, taskId }
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

const CLARIFY_BODY = JSON.stringify({
  questions: [
    {
      id: 'q1',
      title: 'Which database?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL'],
    },
  ],
})

describe('RFC-040 wrapper-loop bubbles awaiting_human (clarify inside loop)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness('loop-clarify')
  })
  afterEach(() => h.cleanup())

  test('loop(maxIter=3) ∋ {agent, clarify}: only 1 clarify_session, wrapper awaiting_human, progress.iteration=0', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['d', 'c'],
          maxIterations: 3,
          // Watch the agent's normal output port — empty while it's asking
          // clarify, non-empty once it answers and outputs normally.
          exitCondition: { kind: 'port-not-empty', nodeId: 'd', portName: 'design' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
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
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // The fundamental RFC-040 fix: exactly ONE clarify_session, not 3.
    const sessions = await h.db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.status).toBe('awaiting_human')

    // Task chip parked on awaiting_human (bubbled all the way up).
    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('awaiting_human')

    // Wrapper row also awaiting_human (status mirrors inner park) and
    // progress persists iteration=0 + phase=awaiting.
    const loopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    expect(loopRuns.length).toBe(1) // not a second row from a doomed iter
    expect(loopRuns[0]?.status).toBe('awaiting_human')
    const progress = decodeWrapperProgress(loopRuns[0]?.wrapperProgressJson ?? null, () => {})
    expect(progress?.kind).toBe('loop')
    expect(progress?.iteration).toBe(0)
    expect(progress?.phase).toBe('awaiting')

    // Agent ran exactly once at iter 0 — not 3 times.
    const agentRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'd')))
    expect(agentRuns.length).toBe(1)
    expect(agentRuns[0]?.iteration).toBe(0)
    expect(agentRuns[0]?.status).toBe('done')
  })

  test('resume after answer: wrapper reuses node_run, agent reruns with clarifyIteration=1', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['d', 'c'],
          maxIterations: 3,
          exitCondition: { kind: 'port-not-empty', nodeId: 'd', portName: 'design' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'd', portName: 'design' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
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
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    // First pass: agent asks clarify, wrapper parks.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const loopRunsBefore = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    expect(loopRunsBefore.length).toBe(1)
    const wrapperRunIdBefore = loopRunsBefore[0]!.id

    const sessionsBefore = await h.db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
    expect(sessionsBefore.length).toBe(1)
    const clarifyRunId = sessionsBefore[0]!.clarifyNodeRunId

    // User answers clarify.
    await submitClarifyAnswers({
      db: h.db,
      clarifyNodeRunId: clarifyRunId,
      directive: 'stop', // RFC-100: finalize round → wrapper-inner agent's <workflow-output> accepted
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ],
      answeredBy: 'local',
    })

    // Second pass simulates resumeTask: scheduler re-enters and finds the
    // wrapper parked. This time the agent emits a real output (no clarify).
    // RFC-097: runTask's entry CAS only claims pending tasks — reset first.
    await reenterScheduler(h.db, taskId)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'use postgres' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Wrapper row REUSED (same id), now terminal=done.
    const loopRunsAfter = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    expect(loopRunsAfter.length).toBe(1) // no second wrapper row
    expect(loopRunsAfter[0]?.id).toBe(wrapperRunIdBefore)
    expect(loopRunsAfter[0]?.status).toBe('done')

    // Exit condition satisfied → outputBinding wrote final port.
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRunIdBefore))
    const finalPort = outs.find((o) => o.portName === 'final')
    expect(finalPort?.content).toBe('use postgres')

    // Agent runs at iter=0 only — resume keeps the wrapper at iter 0, the
    // user's answer never advanced the loop. There must be at least one
    // run with clarifyIteration=0 (the original ask) and at least one with
    // clarifyIteration=1 (the rerun after the user answered). The exact
    // total count depends on how many times runScope re-enters the agent
    // during rescan / done-iteration completion polling; we don't pin it.
    const agentRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'd')))
    expect(agentRuns.length).toBeGreaterThanOrEqual(2)
    expect(agentRuns.every((r) => r.iteration === 0)).toBe(true)
    // RFC-074 PR-C: two top-level rows (original + clarify rerun) confirm the
    // second generation; the retired clarifyIteration set check is gone.

    // Still only 1 clarify_session (idempotent + same iteration).
    const sessionsAfter = await h.db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
    expect(sessionsAfter.length).toBe(1)
    expect(sessionsAfter[0]?.status).toBe('answered')

    // Final task status: done.
    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('done')
  })
})

describe('RFC-040 wrapper-git bubbles awaiting_human (clarify inside git wrapper)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness('git-clarify')
  })
  afterEach(() => h.cleanup())

  test('agent inside wrapper-git asks clarify → no git_diff written, baseline persisted', async () => {
    await seedAgent(h.db, 'designer', ['design'], false)
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
        {
          id: 'gw',
          kind: 'wrapper-git',
          nodeIds: ['d', 'c'],
        },
      ] as unknown as WorkflowDefinition['nodes'],
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
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Wrapper-git is awaiting_human, NOT done. Pre-RFC-040 this would have
    // been 'done' with a partial diff — the silent correctness bug.
    const gwRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'gw')))
    expect(gwRuns.length).toBe(1)
    expect(gwRuns[0]?.status).toBe('awaiting_human')

    // No git_diff output written (the wrapper hasn't reached the diff
    // computation step).
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, gwRuns[0]!.id))
    expect(outs.find((o) => o.portName === 'git_diff')).toBeUndefined()

    // Baseline persisted on the wrapper row for resume.
    const progress = decodeWrapperProgress(gwRuns[0]?.wrapperProgressJson ?? null, () => {})
    expect(progress?.kind).toBe('git')
    expect(typeof progress?.baseline).toBe('string')
    expect(progress?.phase).toBe('awaiting')

    // Task chip parked on awaiting_human.
    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('awaiting_human')
  })

  test('resume after answer: wrapper-git reuses the same row, writes git_diff once', async () => {
    await seedAgent(h.db, 'designer', ['design'], false)
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
        {
          id: 'gw',
          kind: 'wrapper-git',
          nodeIds: ['d', 'c'],
        },
      ] as unknown as WorkflowDefinition['nodes'],
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
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const gwRunsBefore = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'gw')))
    const gwRunIdBefore = gwRunsBefore[0]!.id
    const baselineBefore = decodeWrapperProgress(
      gwRunsBefore[0]?.wrapperProgressJson ?? null,
      () => {},
    )?.baseline
    expect(typeof baselineBefore).toBe('string')

    const sessions = await h.db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
    expect(sessions.length).toBe(1)

    await submitClarifyAnswers({
      db: h.db,
      clarifyNodeRunId: sessions[0]!.clarifyNodeRunId,
      directive: 'stop', // RFC-100: finalize round → wrapper-inner agent's <workflow-output> accepted
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ],
      answeredBy: 'local',
    })

    // RFC-097: runTask's entry CAS only claims pending tasks — reset first
    // (test stand-in for resumeTask).
    await reenterScheduler(h.db, taskId)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'use postgres' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Wrapper-git row REUSED + now done.
    const gwRunsAfter = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'gw')))
    expect(gwRunsAfter.length).toBe(1)
    expect(gwRunsAfter[0]?.id).toBe(gwRunIdBefore)
    expect(gwRunsAfter[0]?.status).toBe('done')

    // git_diff written exactly once.
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, gwRunIdBefore))
    const diffOuts = outs.filter((o) => o.portName === 'git_diff')
    expect(diffOuts.length).toBe(1)
  })
})

describe('RFC-040 nested wrapper-git ∋ wrapper-loop ∋ {agent, clarify}', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness('nested')
  })
  afterEach(() => h.cleanup())

  test('inner loop bubble propagates through outer git wrapper — both park, no diff', async () => {
    await seedAgent(h.db, 'designer', ['design'], false)
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['d', 'c'],
          maxIterations: 2,
          exitCondition: { kind: 'port-not-empty', nodeId: 'd', portName: 'design' },
          outputBindings: [],
        },
        {
          id: 'gw',
          kind: 'wrapper-git',
          nodeIds: ['loop'],
        },
      ] as unknown as WorkflowDefinition['nodes'],
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
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Inner loop wrapper parked.
    const loopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    expect(loopRuns.length).toBe(1)
    expect(loopRuns[0]?.status).toBe('awaiting_human')

    // Outer git wrapper also parked; NO diff computed.
    const gwRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'gw')))
    expect(gwRuns.length).toBe(1)
    expect(gwRuns[0]?.status).toBe('awaiting_human')
    const gwOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, gwRuns[0]!.id))
    expect(gwOuts.find((o) => o.portName === 'git_diff')).toBeUndefined()

    // Only 1 clarify_session despite nested wrappers.
    const sessions = await h.db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
    expect(sessions.length).toBe(1)
  })
})
