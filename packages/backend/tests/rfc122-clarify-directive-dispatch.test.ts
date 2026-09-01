// RFC-122 — integration: a self-clarify node with a 'stop' override dispatches
// WITHOUT the mandatory ask-back protocol (and WITH the STOP CLARIFYING trailer),
// driven through the REAL scheduler (runTask) + the REAL unified answer driver
// (autoDispatchClarifyRound), reading the prompt the runner actually wrote
// (RFC-311 T21: 超阈值的正文在文件里, 一律走 readNodeRunPrompt 双读).
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

import { createSqliteMemoryDistillEnqueuer } from './helpers/memoryDistill'
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { readNodeRunPrompt } from '../src/services/nodeRunPrompt'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  abortAllActiveTasks,
  isTaskActive,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
import {
  getNodeClarifyDirective,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
} from '../src/services/taskClarifyDirective'
import { reenterScheduler } from './reenter-scheduler'
import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { nonInteractiveGitEnv } from '../src/util/git'
import {
  createTaskExecutionTestTopology,
  runTaskWithRealTestTopology as runTaskBase,
} from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000
const ACTIVE_TASK_SETTLE_TIMEOUT_MS = 5_000

let cleanupCtx: (() => void) | undefined
let watchdog: ReturnType<typeof setTimeout> | undefined

setDefaultTimeout(FLOW_TIMEOUT_MS + ACTIVE_TASK_SETTLE_TIMEOUT_MS + 5_000)

beforeEach(() => {
  cleanupCtx = undefined
  watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
})

afterEach(async () => {
  if (watchdog !== undefined) clearTimeout(watchdog)
  try {
    await abortActiveTasksAndWait('test-cleanup')
  } finally {
    cleanupCtx?.()
  }
})

async function abortActiveTasksAndWait(reason: string): Promise<void> {
  const taskIds = abortAllActiveTasks(reason)
  const deadline = Date.now() + ACTIVE_TASK_SETTLE_TIMEOUT_MS
  while (taskIds.some((taskId) => isTaskActive(taskId)) && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  const stuck = taskIds.filter((taskId) => isTaskActive(taskId))
  if (stuck.length > 0) throw new Error(`active test tasks failed to settle: ${stuck.join(', ')}`)
}

function git(...args: string[]): void {
  execFileSync('git', args, {
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS,
    env: nonInteractiveGitEnv(),
  })
}

function runTask(options: Parameters<typeof runTaskBase>[0]) {
  return runTaskBase({
    ...options,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

function startTaskWithLocalRepo(
  input: Parameters<typeof startTaskWithLocalRepoBase>[0],
  deps: Parameters<typeof startTaskWithLocalRepoBase>[1],
) {
  return startTaskWithLocalRepoBase(input, {
    ...deps,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

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
}
let idx = 0
async function freshCtx(): Promise<Ctx> {
  idx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc122-${idx}-`))
  const previousPlanFile = process.env.SCENARIO_PLAN_FILE
  const previousStateDir = process.env.SCENARIO_STATE_DIR
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME
  let cleaned = false
  cleanupCtx = () => {
    if (cleaned) return
    cleaned = true
    rmSync(tmp, { recursive: true, force: true })
    if (previousPlanFile === undefined) delete process.env.SCENARIO_PLAN_FILE
    else process.env.SCENARIO_PLAN_FILE = previousPlanFile
    if (previousStateDir === undefined) delete process.env.SCENARIO_STATE_DIR
    else process.env.SCENARIO_STATE_DIR = previousStateDir
    if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousAppHome
  }
  const appHome = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  const stateDir = join(tmp, 'state')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  git('init', '-b', 'main', repoPath)
  git('-C', repoPath, 'config', 'user.email', 't@t.test')
  git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  git('-C', repoPath, 'add', '.')
  git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')
  process.env.SCENARIO_STATE_DIR = stateDir
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  await seedTestDefaultOpencodeRuntime(db)
  return {
    db,
    appHome,
    repoPath,
    stateDir,
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
// RFC-122: read the scenario stub's per-invocation trace (the `--session` arg it
// was spawned with) to tell a same-session RESUME apart from a FRESH session.
interface TraceEntry {
  agent: string
  callIndex: number
  session: string | null
}
function readTrace(stateDir: string, agent: string): TraceEntry[] {
  const f = join(stateDir, 'trace.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEntry)
    .filter((e) => e.agent === agent)
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
  const designer = await createAgent(c.db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
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
      {
        id: 'designer',
        kind: 'agent-single',
        agentId: designer.id,
        agentName: 'designer',
      },
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
    .from(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.status, 'awaiting_human')))
  const id = rows[0]?.intermediaryNodeRunId
  if (!id) throw new Error('no awaiting clarify session')
  return id
}
async function taskStatus(db: DbClient, taskId: string): Promise<string> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  return t?.status ?? '??'
}

describe('RFC-122 dispatch — stop override suppresses the ask-back protocol', () => {
  let c: Ctx
  beforeEach(async () => {
    c = await freshCtx()
  })

  test('golden-lock: no override ⇒ first dispatch carries MANDATORY ASK-BACK', async () => {
    writePlan(c.appHome, { designer: [{ clarify: { questions: [Q] } }] })
    const wf = await designerSelfClarifyWorkflow(c, 'gl')
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'gl',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db: c.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: c.db, driver: 'real' })
          .schedulerDriver,
        appHome: c.appHome,
        binaryOverride: opencodeCmd(),
        awaitScheduler: true,
      },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    const first = (await designerTop(c.db, task.id))[0]
    expect(readNodeRunPrompt(first, join(c.appHome, 'runs')) ?? '').toContain(MANDATORY)
    expect(readNodeRunPrompt(first, join(c.appHome, 'runs')) ?? '').not.toContain(STOP_TRAILER)
    // No override row was ever created.
    expect(await listNodeClarifyDirectives(c.db, task.id)).toEqual({})
  })

  test('override stop beats a "continue" answer: rerun has STOP CLARIFYING + output, no ask-back', async () => {
    writePlan(c.appHome, {
      designer: [{ clarify: { questions: [Q] } }, { output: { design: 'D1' } }],
    })
    const wf = await designerSelfClarifyWorkflow(c, 'ov')
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'ov',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db: c.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: c.db, driver: 'real' })
          .schedulerDriver,
        appHome: c.appHome,
        binaryOverride: opencodeCmd(),
        awaitScheduler: true,
      },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')

    // The user toggles the canvas to "停止反问" while the node is parked, THEN
    // answers "keep clarifying" — the toggle must win.
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'stop', 'u-tester')
    await autoDispatchClarifyRound({
      db: c.db,
      memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(c.db),
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [ANSWER],
      directive: 'continue',
      actor: { userId: 'u-tester', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, binaryOverride: opencodeCmd() })

    const rerun = (await designerTop(c.db, task.id))[0]
    const prompt = readNodeRunPrompt(rerun, join(c.appHome, 'runs')) ?? ''
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
  beforeEach(async () => {
    c = await freshCtx()
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
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'h1',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db: c.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: c.db, driver: 'real' })
          .schedulerDriver,
        appHome: c.appHome,
        binaryOverride: opencodeCmd(),
        awaitScheduler: false,
      },
    )

    // Wait until attempt 0 (retry_index 0) has rendered its prompt under the
    // DEFAULT directive (the stub is now paused on the sentinel).
    const attempt0 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 0)
      return readNodeRunPrompt(r, join(c.appHome, 'runs')) !== null ? r : undefined
    })
    expect(readNodeRunPrompt(attempt0, join(c.appHome, 'runs')) ?? '').toContain(MANDATORY)
    expect(readNodeRunPrompt(attempt0, join(c.appHome, 'runs')) ?? '').not.toContain(STOP_TRAILER)

    // Flip the toggle to STOP, THEN release attempt 0 (→ crash → process-retry).
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'stop', 'u1')
    writeFileSync(join(c.stateDir, 'go'), '1')

    // attempt 1 (retry_index 1, cause=process-retry) must reflect the NEW value.
    const attempt1 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 1)
      return readNodeRunPrompt(r, join(c.appHome, 'runs')) !== null ? r : undefined
    })
    expect(attempt1.rerunCause).toBe('process-retry')
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').toContain(STOP_TRAILER)
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').toContain(OUTPUT_PROTO)
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').not.toContain(MANDATORY)

    // Let the background scheduler settle (attempt 1 outputs → done) before
    // afterEach removes the worktree, so its final writes don't race the rmSync.
    await poll(async () => {
      const s = await taskStatus(c.db, task.id)
      return s === 'done' || s === 'failed' ? s : undefined
    })
  })
})

// RFC-122 same-session follow-up edge: when the STOP toggle flips a retry from
// clarify-active to output mode, the same-session envelope follow-up (which only
// re-anchors on "the format previously specified in this session") is bypassed in
// favor of the FULL renderUserPrompt — so the agent gets the STOP notice + the
// complete output protocol it never saw in the clarify-only session.
describe('RFC-122 — STOP flip on a same-session FOLLOW-UP renders the full output protocol', () => {
  let c: Ctx
  beforeEach(async () => {
    c = await freshCtx()
  })

  test('clarify-required follow-up + mid-loop stop flip → attempt 1 has STOP CLARIFYING + output protocol', async () => {
    // attempt 0: clarify-active; emits a session id (→ follow-up eligible) then
    //   WAITS, then emits <workflow-output> while ask-back is mandatory →
    //   clarify-required failure (exit 0) → same-session FOLLOW-UP eligible.
    // attempt 1: toggle flipped to stop → effectiveHasClarifyChannel=false; the
    //   follow-up is BYPASSED → full renderUserPrompt with STOP + output protocol.
    writePlan(c.appHome, {
      designer: [
        { output: { design: 'x' }, sessionId: 'ses_h3', waitFile: 'go' },
        { output: { design: 'D1' } },
      ],
    })
    const wf = await designerSelfClarifyWorkflow(c, 'fu')
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'fu',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db: c.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: c.db, driver: 'real' })
          .schedulerDriver,
        appHome: c.appHome,
        binaryOverride: opencodeCmd(),
        awaitScheduler: false,
      },
    )

    const attempt0 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 0)
      return readNodeRunPrompt(r, join(c.appHome, 'runs')) !== null ? r : undefined
    })
    // Precondition: attempt 0 ran clarify-only (no output protocol in its prompt).
    expect(readNodeRunPrompt(attempt0, join(c.appHome, 'runs')) ?? '').toContain(MANDATORY)
    expect(readNodeRunPrompt(attempt0, join(c.appHome, 'runs')) ?? '').not.toContain(OUTPUT_PROTO)

    await setNodeClarifyDirective(c.db, task.id, 'designer', 'stop', 'u1')
    writeFileSync(join(c.stateDir, 'go'), '1')

    const attempt1 = await poll(async () => {
      const r = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 1)
      return readNodeRunPrompt(r, join(c.appHome, 'runs')) !== null ? r : undefined
    })
    // The bypass: the FULL output protocol + STOP CLARIFYING (not the short
    // "format previously specified in this session" follow-up re-anchor).
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').toContain(STOP_TRAILER)
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').toContain(OUTPUT_PROTO)
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').not.toContain(MANDATORY)
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').not.toContain(
      'previously specified in this session',
    )

    await poll(async () => {
      const s = await taskStatus(c.db, task.id)
      return s === 'done' || s === 'failed' ? s : undefined
    })
    // Session-clear: the mode-flip retry runs in a FRESH opencode session (no
    // `--session`), NOT the prior clarify-only follow-up session 'ses_h3'.
    const flipTrace = readTrace(c.stateDir, 'designer').find((e) => e.callIndex === 1)
    expect(flipTrace?.session ?? null).toBeNull()
  })

  test('golden-lock: no override ⇒ the same-session follow-up prompt is unchanged', async () => {
    // Same clarify-required failure, but NO toggle flip: attempt 1 stays a normal
    // clarify-mode follow-up (short re-anchor), byte-for-byte today's behavior.
    writePlan(c.appHome, {
      designer: [{ output: { design: 'x' }, sessionId: 'ses_gl' }, { clarify: { questions: [Q] } }],
    })
    const wf = await designerSelfClarifyWorkflow(c, 'fugl')
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'fugl',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db: c.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: c.db, driver: 'real' })
          .schedulerDriver,
        appHome: c.appHome,
        binaryOverride: opencodeCmd(),
        awaitScheduler: true,
      },
    )

    const attempt1 = (await designerTop(c.db, task.id)).find((x) => x.retryIndex === 1)
    expect(attempt1?.rerunCause).toBe('process-retry')
    // The follow-up path (clarify-mode) — NOT the full renderUserPrompt: it re-
    // anchors on the format "previously specified in this session" and does NOT
    // emit a STOP notice.
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').toContain(
      'previously specified in this session',
    )
    expect(readNodeRunPrompt(attempt1, join(c.appHome, 'runs')) ?? '').not.toContain(STOP_TRAILER)
    // Golden-lock: the same-session follow-up RESUMES the captured session
    // 'ses_gl' (`--session ses_gl`) — byte-for-byte today's behavior.
    const glTrace = readTrace(c.stateDir, 'designer').find((e) => e.callIndex === 1)
    expect(glTrace?.session).toBe('ses_gl')
    // No override row was ever created.
    expect(await listNodeClarifyDirectives(c.db, task.id)).toEqual({})
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
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // Dispatch read (parallel to hasPersistentStop) gated on hasClarifyChannel.
    expect(src).toContain('collaboration.getNodeClarifyDirective({ taskId, nodeId: node.id })')
    expect(src).toContain('const nodeStopOverride =')
    // RFC-132 (PR-C): TWO threads now — the effective-channel oracle + the runNode stop notice. The
    // per-round injector override thread is gone (the flat context carries no directive; the node
    // clarify state is the single source — design §7). A 'continue' toggle re-opens ask-back because
    // nodeStopOverride flips false in the oracle.
    expect(src).toContain('resolveEffectiveClarifyChannel({')
    expect(src).toContain('nodeStopOverride,')
    expect(src).toContain('contextDirective: nodeDirective')
    expect(src).not.toContain('directiveOverride')
    expect(src).toContain('shouldInjectStopNotice({')
  })

  test('H1: the override is read INSIDE the retry loop (per attempt), not cached before it', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // The getNodeClarifyDirective read must happen ONCE PER ATTEMPT so each
    // attempt's freshly-minted process-retry row re-reads the latest toggle. A
    // refactor that hoists it above the per-attempt boundary (stale cache) → red.
    //
    // RFC-287 T7 改锚：重试循环从 `for (let attempt = retryIndex; …)` 变成骨架驱动
    // ——每轮调一次 `runOneAttempt(k)`。「在循环体内」于是等价于「在该函数体内」。
    // 不变量与射程都没变，只是边界的名字变了。
    // RFC-313 改锚（**意图不变，判据变强**）：本条原先取 `indexOf` 的**首个**命中，
    // 隐含「全文件只有一个读点」。RFC-313 在 `keepIf`（decideFollowupForRetry）里新增
    // 了第二个合法读点——它同样是**每轮重试各读一次**，用来判断「本轮有没有待处理的
    // STOP 翻转」以压制会话升级（否则链顶恰逢翻转时升级会抢先、丢树+扣预算）。首个命中
    // 于是落在 runOneAttempt 之前，原写法转红，但不变量并未失守。
    // 新判据逐点定位：**每一个**读点都必须落在某个 per-attempt 区域内（机身函数，或
    // 每轮重试都会被调用的 keepIf 回调），任何落在两者之外的读点即为「提到边界外缓存」
    // ——那正是本条要拦的回归，而这个版本比「首个命中在某位置之后」拦得更严。
    const attemptFnIdx = src.indexOf('const runOneAttempt = async')
    const keepIfIdx = src.indexOf('const decideFollowupForRetry = async')
    const prepareIdx = src.indexOf('const prepareRetryAttempt = async')
    expect(attemptFnIdx, '每 attempt 机身函数应存在（重试边界）').toBeGreaterThan(0)
    expect(keepIfIdx, 'keepIf 回调应存在（每轮重试各调一次）').toBeGreaterThan(0)
    const reads: number[] = []
    const directiveRead = 'collaboration.getNodeClarifyDirective({ taskId, nodeId: node.id })'
    for (let i = src.indexOf(directiveRead); i >= 0; ) {
      reads.push(i)
      i = src.indexOf(directiveRead, i + 1)
    }
    expect(reads.length, '至少要有一个 directive 读点').toBeGreaterThan(0)
    expect(
      reads.some((i) => i > attemptFnIdx),
      '机身函数内必须仍有一个读点（每 attempt 重读最新 toggle）',
    ).toBe(true)
    for (const i of reads) {
      const inAttemptBody = i > attemptFnIdx
      const inKeepIf = i > keepIfIdx && i < prepareIdx
      expect(inAttemptBody || inKeepIf, `directive 读点 @${i} 落在 per-attempt 区域之外`).toBe(true)
    }
    // 反向：读点不得落在窗口外的一次性前奏里（那正是「提到循环外缓存」的形状）。
    const windowIdx = src.indexOf('const windowOut = await runAssembly<')
    expect(windowIdx).toBeGreaterThan(0)
    // RFC-313 改锚：由「那一个读点」推广到「每一个读点」——两个合法读点都在回调
    // 定义里（keepIf / 机身函数），都排在 runAssembly 调用点之前。
    for (const i of reads) expect(i).toBeLessThan(windowIdx)
  })

  test('same-session follow-up is bypassed when the STOP toggle flips the mode', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // The clarifyModeFlip guard + the gated envelopeFollowup arg. Without the
    // `&& !clarifyModeFlip` the runner would re-anchor on a protocol the resumed
    // clarify-only session never emitted.
    expect(src).toContain('const clarifyModeFlip =')
    expect(src).toContain('priorAttemptClarifyActive !== effectiveHasClarifyChannel')
    expect(src).toContain('followupDecision.followup && !clarifyModeFlip')
  })

  test('mode-flip session-clear: effectiveResumeSessionId also gates on !clarifyModeFlip', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // A mode-flip retry must NOT resume the prior (wrong-mode) session — the
    // resume id also drops to the isolated/fresh path on a flip.
    // (RFC-132 ③: the RFC-127 `isBorrowed ?` special case is gone with the borrow
    // ledger — a node always runs its own agent, so only the mode-flip gate remains.)
    const m = src.match(/const effectiveResumeSessionId =\s*([\s\S]{0,600})/)
    expect(m?.[1] ?? '').toContain('followupDecision.followup && !clarifyModeFlip')
    expect(m?.[1] ?? '').not.toContain('isBorrowed')
  })
})
