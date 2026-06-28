// RFC-122 — integration: a self-clarify node with a 'stop' override dispatches
// WITHOUT the mandatory ask-back protocol (and WITH the STOP CLARIFYING trailer),
// driven through the REAL scheduler (runTask) + REAL submitClarifyAnswers, reading
// the actual node_run.promptText the runner wrote.
//
//   - golden-lock: no override row ⇒ the designer's first dispatch carries the
//     MANDATORY ASK-BACK preamble (today's behavior, byte-for-byte).
//   - override: set directive='stop' on the parked designer, answer "continue"
//     (which WITHOUT the override would force another ask-back round) ⇒ the
//     rerun's prompt has NO mandatory ask-back, HAS STOP CLARIFYING + the output
//     protocol. This is the Case-B conflict (toggle beats a 'continue' answer).
//
// Plus a store round-trip and a source-level lock on the scheduler wiring (the
// dispatch read + the three threads) so a refactor that drops any of them goes red.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { submitClarifyAnswers } from '../src/services/clarify'
import { runTask } from '../src/services/scheduler'
import { startTask } from '../src/services/task'
import {
  getNodeClarifyDirective,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
} from '../src/services/taskClarifyDirective'
import { reenterScheduler } from './reenter-scheduler'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

const MANDATORY = 'MANDATORY ASK-BACK (clarify) mode'
const STOP_TRAILER = '### User directive: STOP CLARIFYING'
const OUTPUT_PROTO = 'You MUST end your reply with a'

const Q: ClarifyQuestion = {
  id: 'q1',
  title: 'Which option?',
  kind: 'single',
  recommended: false,
  options: [
    { label: 'A', description: '', recommended: true, recommendationReason: '' },
    { label: 'B', description: '', recommended: false, recommendationReason: '' },
  ],
}
const ANSWER: ClarifyAnswer = {
  questionId: 'q1',
  selectedOptionIndices: [0],
  selectedOptionLabels: ['A'],
  customText: '',
}

interface Ctx {
  db: DbClient
  appHome: string
  repoPath: string
  stateDir: string
  cleanup: () => void
}
let idx = 0
function freshCtx(): Ctx {
  idx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc122-${idx}-`))
  const appHome = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  const stateDir = join(tmp, 'state')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, { stdio: 'ignore' })
  process.env.SCENARIO_STATE_DIR = stateDir
  process.env.AGENT_WORKFLOW_HOME = appHome
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    repoPath,
    stateDir,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.SCENARIO_PLAN_FILE
      delete process.env.SCENARIO_STATE_DIR
      delete process.env.AGENT_WORKFLOW_HOME
    },
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('poll timed out')
    await sleep(25)
  }
}
function writePlan(tmpHome: string, plan: Record<string, unknown[]>): void {
  const f = join(tmpHome, 'plan.json')
  writeFileSync(f, JSON.stringify(plan))
  process.env.SCENARIO_PLAN_FILE = f
}
function opencodeCmd(): string[] {
  return ['bun', 'run', SCENARIO_STUB]
}
async function designerSelfClarifyWorkflow(c: Ctx, name: string) {
  await createAgent(c.db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
  const def: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [{ kind: 'text', key: 'topic', label: 't' }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'topic' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'clr', kind: 'clarify' },
    ] as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in1', portName: 'topic' },
        target: { nodeId: 'designer', portName: 'topic' },
      },
      {
        id: 'e2',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clr', portName: 'questions' },
      },
      {
        id: 'e3',
        source: { nodeId: 'clr', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    ],
  }
  return createWorkflow(c.db, { name, description: '', definition: def })
}
async function designerTop(db: DbClient, taskId: string) {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
  return rows.filter((r) => r.parentNodeRunId === null).sort((a, b) => (a.id < b.id ? 1 : -1))
}
async function openClarifyRunId(db: DbClient, taskId: string): Promise<string> {
  const rows = await db
    .select()
    .from(clarifySessions)
    .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
  const id = rows[0]?.clarifyNodeRunId
  if (!id) throw new Error('no awaiting clarify session')
  return id
}
async function taskStatus(db: DbClient, taskId: string): Promise<string> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  return t?.status ?? '??'
}

describe('RFC-122 dispatch — stop override suppresses the ask-back protocol', () => {
  let c: Ctx
  beforeEach(() => {
    c = freshCtx()
  })
  afterEach(() => {
    c.cleanup()
  })

  test('golden-lock: no override ⇒ first dispatch carries MANDATORY ASK-BACK', async () => {
    writePlan(c.appHome, { designer: [{ clarify: { questions: [Q] } }] })
    const wf = await designerSelfClarifyWorkflow(c, 'gl')
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'gl',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    const first = (await designerTop(c.db, task.id))[0]
    expect(first?.promptText ?? '').toContain(MANDATORY)
    expect(first?.promptText ?? '').not.toContain(STOP_TRAILER)
    // No override row was ever created.
    expect(await listNodeClarifyDirectives(c.db, task.id)).toEqual({})
  })

  test('override stop beats a "continue" answer: rerun has STOP CLARIFYING + output, no ask-back', async () => {
    writePlan(c.appHome, {
      designer: [{ clarify: { questions: [Q] } }, { output: { design: 'D1' } }],
    })
    const wf = await designerSelfClarifyWorkflow(c, 'ov')
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'ov',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')

    // The user toggles the canvas to "停止反问" while the node is parked, THEN
    // answers "keep clarifying" — the toggle must win.
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'stop', 'u-tester')
    await submitClarifyAnswers({
      db: c.db,
      clarifyNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [ANSWER],
      directive: 'continue',
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rerun = (await designerTop(c.db, task.id))[0]
    const prompt = rerun?.promptText ?? ''
    expect(prompt).toContain(STOP_TRAILER)
    expect(prompt).toContain(OUTPUT_PROTO)
    expect(prompt).not.toContain(MANDATORY)
    // The toggle's "continue" answer's KEEP trailer must NOT survive the override.
    expect(prompt).not.toContain('KEEP CLARIFYING')
    // The designer finalized (output mode accepted), so the task is no longer parked.
    expect(await taskStatus(c.db, task.id)).not.toBe('awaiting_human')
  })
})

// RFC-122 H1 regression: the directive is read per-ATTEMPT inside the retry loop,
// so an error-retry's freshly-minted process-retry row honors a toggle flipped
// while the failed attempt was running — not a value cached once before the loop.
describe('RFC-122 H1 — process retry reads the LATEST directive per attempt', () => {
  let c: Ctx
  beforeEach(() => {
    c = freshCtx()
  })
  afterEach(() => {
    c.cleanup()
  })

  test('a flip between a failed attempt and its process-retry is honored by the retry prompt', async () => {
    // attempt 0: no directive row → default 'continue' → mandatory ask-back; the
    //   stub WAITS for a sentinel then crashes (exit 1) → fresh-session retry.
    // attempt 1 (process-retry): must read the directive flipped to 'stop' while
    //   attempt 0 was paused → ask-back suppressed + STOP CLARIFYING.
    writePlan(c.appHome, {
      designer: [{ waitFile: 'go', crash: true }, { output: { design: 'D1' } }],
    })
    const wf = await designerSelfClarifyWorkflow(c, 'h1')
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'h1',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: false },
    )

    // Wait until attempt 0 (retry_index 0) has rendered its prompt under the
    // DEFAULT directive (the stub is now paused on the sentinel).
    const attempt0 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 0)
      return r?.promptText ? r : undefined
    })
    expect(attempt0.promptText ?? '').toContain(MANDATORY)
    expect(attempt0.promptText ?? '').not.toContain(STOP_TRAILER)

    // Flip the toggle to STOP, THEN release attempt 0 (→ crash → process-retry).
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'stop', 'u1')
    writeFileSync(join(c.stateDir, 'go'), '1')

    // attempt 1 (retry_index 1, cause=process-retry) must reflect the NEW value.
    const attempt1 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 1)
      return r?.promptText ? r : undefined
    })
    expect(attempt1.rerunCause).toBe('process-retry')
    expect(attempt1.promptText ?? '').toContain(STOP_TRAILER)
    expect(attempt1.promptText ?? '').toContain(OUTPUT_PROTO)
    expect(attempt1.promptText ?? '').not.toContain(MANDATORY)

    // Let the background scheduler settle (attempt 1 outputs → done) before
    // afterEach removes the worktree, so its final writes don't race the rmSync.
    await poll(async () => {
      const s = await taskStatus(c.db, task.id)
      return s === 'done' || s === 'failed' ? s : undefined
    })
  })
})

describe('RFC-122 store round-trip + scheduler wiring lock', () => {
  test('set / get / list round-trip; continue is read back identically', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({
      id: 'wf',
      name: 'wf',
      definition: '{}',
      description: '',
      version: 1,
      schemaVersion: 3,
    })
    await db.insert(tasks).values({
      id: 'tk',
      name: 't',
      ownerUserId: '__system__',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '/r',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'b',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    expect(await getNodeClarifyDirective(db, 'tk', 'n1')).toBeUndefined()
    await setNodeClarifyDirective(db, 'tk', 'n1', 'stop', 'u1')
    await setNodeClarifyDirective(db, 'tk', 'n2', 'continue', 'u1')
    expect(await getNodeClarifyDirective(db, 'tk', 'n1')).toBe('stop')
    expect(await getNodeClarifyDirective(db, 'tk', 'n2')).toBe('continue')
    expect(await listNodeClarifyDirectives(db, 'tk')).toEqual({ n1: 'stop', n2: 'continue' })
    // Upsert flips in place.
    await setNodeClarifyDirective(db, 'tk', 'n1', 'continue', 'u2')
    expect(await getNodeClarifyDirective(db, 'tk', 'n1')).toBe('continue')
  })

  test('scheduler reads the override at dispatch and threads it (source-level lock)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // Dispatch read (parallel to hasPersistentStop) gated on hasClarifyChannel.
    expect(src).toContain('getNodeClarifyDirective(db, taskId, node.id)')
    expect(src).toContain('const nodeStopOverride =')
    // Three threads: effective-channel oracle, buildPromptContext override, runNode notice.
    expect(src).toContain('resolveEffectiveClarifyChannel({')
    expect(src).toContain('nodeStopOverride,')
    expect(src).toContain("directiveOverride: 'stop' as const")
    expect(src).toContain('shouldInjectStopNotice({')
  })

  test('H1: the override is read INSIDE the retry loop (per attempt), not cached before it', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // The getNodeClarifyDirective read must sit AFTER the retry-loop header so each
    // attempt's freshly-minted process-retry row re-reads the latest toggle. A
    // refactor that hoists it back above the loop (stale cache) → red.
    const loopIdx = src.indexOf('for (let attempt = retryIndex;')
    const readIdx = src.indexOf('getNodeClarifyDirective(db, taskId, node.id)')
    expect(loopIdx).toBeGreaterThan(0)
    expect(readIdx).toBeGreaterThan(loopIdx)
  })
})
