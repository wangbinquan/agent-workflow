// RFC-026 T7 — scheduler integration for clarify inline-session mode.
//
// Drives runTask end-to-end against mock-opencode and asserts the scheduler:
//   - captures opencode session id into node_runs.opencode_session_id
//     (whether or not inline mode is enabled — proposal §2.1 #2)
//   - on a clarify-driven rerun (clarifyIteration > 0 + retryIndex === 0)
//     with sessionMode='inline', passes `--session <id>` to the spawn AND
//     emits the inline-mode prompt (no Prior Rounds Questions section,
//     inline reminder at the tail)
//   - defaults to isolated (no --session) and emits a warning event when
//     the prior session id is missing — proposal §A4
//   - isolated mode never passes --session — proposal §A1 / §A12
//
// Uses MOCK_OPENCODE_CAPTURE_ARGV_TO + MOCK_OPENCODE_EMIT_SESSION_ID added in
// fixtures/mock-opencode.ts (RFC-026 additive helpers).

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  clarifySessions,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { submitClarifyAnswers } from '../src/services/clarify'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  argvCapturePath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc026-sched-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const argvCapturePath = join(appHome, 'argv.jsonl')
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
    argvCapturePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['design']),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

interface DefOpts {
  sessionMode?: 'isolated' | 'inline'
}

function makeDef(opts: DefOpts = {}): WorkflowDefinition {
  const clarifyNode: Record<string, unknown> = { id: 'c', kind: 'clarify', title: 'C' }
  if (opts.sessionMode !== undefined) clarifyNode.sessionMode = opts.sessionMode
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      clarifyNode as WorkflowNode,
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
}

async function seedWorkflowAndTask(
  h: Harness,
  def: WorkflowDefinition,
): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'go' }),
    startedAt: Date.now(),
  })
  return { taskId }
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

function readCapturedArgvLines(path: string): Array<{ agent: string; argv: string[] }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { agent: string; argv: string[] })
}

const CLARIFY_BODY = JSON.stringify({
  questions: [
    {
      id: 'q1',
      title: 'Which DB?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL'],
    },
  ],
})

describe('RFC-026 scheduler clarify inline-mode', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('opencode session id is persisted to node_runs.opencode_session_id after a normal clarify-channel run', async () => {
    await seedAgent(h.db, 'designer')
    const { taskId } = await seedWorkflowAndTask(h, makeDef({ sessionMode: 'inline' }))
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_first_round',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const designerRun = runs.find((r) => r.nodeId === 'd' && r.clarifyIteration === 0)
    expect(designerRun?.opencodeSessionId).toBe('opc_first_round')
  })

  test('inline mode + answered prior round → next spawn carries `--session <id>` and emits info event', async () => {
    await seedAgent(h.db, 'designer')
    const { taskId } = await seedWorkflowAndTask(h, makeDef({ sessionMode: 'inline' }))

    // Round 0: agent asks (clarify envelope) and reports session id.
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_R0',
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    // User submits answers → mints rerun row (clarifyIteration=1).
    const sessionRow = (
      await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
    )[0]
    expect(sessionRow).toBeDefined()
    await submitClarifyAnswers({
      db: h.db,
      clarifyNodeRunId: sessionRow!.clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    })

    // Round 1: agent runs again. Inline mode → spawn argv contains
    // `--session opc_R0`. Mock returns a normal <workflow-output> so the
    // task can finish.
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'done' }),
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_R0', // same session id continues
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    // 2 spawns (R0 + R1). R1's argv must include --session opc_R0.
    const argvLines = readCapturedArgvLines(h.argvCapturePath)
    expect(argvLines.length).toBeGreaterThanOrEqual(2)
    const round1Argv = argvLines[1]!.argv
    expect(round1Argv).toContain('--session')
    const flagIdx = round1Argv.indexOf('--session')
    expect(round1Argv[flagIdx + 1]).toBe('opc_R0')

    // R0's argv MUST NOT contain --session (no prior round to resume).
    expect(argvLines[0]!.argv).not.toContain('--session')

    // The rerun's user prompt is inline-mode shape: skips Prior Rounds
    // Questions, retains User Answers (Current Round), ends with inline
    // reminder. Pull it off the rerun row.
    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const rerun = allRuns.find((r) => r.nodeId === 'd' && r.clarifyIteration === 1)
    expect(rerun).toBeDefined()
    expect(rerun?.promptText ?? '').toContain('User Answers (Current Round)')
    expect(rerun?.promptText ?? '').not.toContain('Prior Rounds (Questions)')
    expect(rerun?.promptText ?? '').toContain(
      'Earlier rounds, the full envelope formats, and the asking-back rules are still in this session',
    )

    // Info event recorded.
    const events = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, rerun!.id))
    const infoEvents = events.filter((e) => e.payload.includes('[rfc026/inline-session-resumed]'))
    expect(infoEvents.length).toBe(1)
    expect(infoEvents[0]!.payload).toContain('clarify-session-resumed')
    expect(infoEvents[0]!.payload).toContain('opc_R0')
  })

  test('isolated mode (default) never passes --session — RFC-023 byte-for-byte path preserved', async () => {
    await seedAgent(h.db, 'designer')
    // No sessionMode → undefined → resolved to isolated.
    const { taskId } = await seedWorkflowAndTask(h, makeDef({}))

    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_iso_R0',
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const sessionRow = (
      await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
    )[0]
    await submitClarifyAnswers({
      db: h.db,
      clarifyNodeRunId: sessionRow!.clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'done' }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const lines = readCapturedArgvLines(h.argvCapturePath)
    for (const line of lines) {
      expect(line.argv).not.toContain('--session')
    }

    // Rerun's prompt carries the legacy multi-round dump section names.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const rerun = runs.find((r) => r.nodeId === 'd' && r.clarifyIteration === 1)
    expect(rerun?.promptText ?? '').toContain('Prior Rounds (Answers)')
    expect(rerun?.promptText ?? '').not.toContain('User Answers (Current Round)')
  })

  test('inline mode + prior round did NOT capture session id → fallback warning + no --session', async () => {
    await seedAgent(h.db, 'designer')
    const { taskId } = await seedWorkflowAndTask(h, makeDef({ sessionMode: 'inline' }))

    // Round 0: agent asks BUT does NOT emit a session id (mock without
    // MOCK_OPENCODE_EMIT_SESSION_ID). Simulates an early-failing opencode
    // that drops the JSON session event.
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const sessionRow = (
      await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
    )[0]
    expect(sessionRow).toBeDefined()
    await submitClarifyAnswers({
      db: h.db,
      clarifyNodeRunId: sessionRow!.clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'done' }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvCapturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    // No --session on either spawn (R0 didn't have a prior; R1 fell back).
    const lines = readCapturedArgvLines(h.argvCapturePath)
    for (const line of lines) {
      expect(line.argv).not.toContain('--session')
    }
    // Fallback warning event on the rerun row.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const rerun = runs.find((r) => r.nodeId === 'd' && r.clarifyIteration === 1)!
    const events = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, rerun.id))
    const fallback = events.find((e) => e.payload.includes('[rfc026/inline-fallback]'))
    expect(fallback?.payload).toContain('missing-session-id')
    // Rerun prompt is the isolated shape (since we fell back) — multi-round dump section names appear.
    expect(rerun.promptText ?? '').toContain('Prior Rounds (Answers)')
  })
})
