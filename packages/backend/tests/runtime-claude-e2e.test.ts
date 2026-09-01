// RFC-111 PR-B — end-to-end runNode against the claude-code runtime via the
// mock-claude harness (no real API). Locks the claude headless contract:
// argv (-p / --output-format stream-json / --append-system-prompt-file / --model
// / --disallowed-tools), prompt-over-stdin (D12), persona = agent.bodyMd in the
// system-prompt file (D6), stream-json envelope → outputs, session capture,
// token accumulation from the result event, and is_error/exit → failed.
// Regression 2026-08-13: Claude can explicitly reset a conversation within one
// process; the next root frame's native id becomes the resumable identity.

import type { Agent, RuntimeInventoryObservation } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import type { Logger } from '../src/util/log'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, runtimeSessionLeases, tasks, workflows } from '../src/db/schema'
import { runNode } from './helpers/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_CLAUDE = resolve(import.meta.dir, 'fixtures', 'mock-claude.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: ulid(),
    name: 'claude-agent',
    description: 'a claude agent',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You are a Claude-driven test agent.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-claude-runner-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'node1', status: 'pending' })
  return id
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

interface RunOpts {
  agent: Agent
  nodeRunId: string
  h: Harness
  /** RFC-113: claude's model now comes from the runtime profile, not agent.model. */
  runtimeParams?: RuntimeProfile
  log?: Logger
}
function runClaude(o: RunOpts) {
  return runNode({
    taskId: o.h.taskId,
    nodeRunId: o.nodeRunId,
    nodeId: 'node1',
    agent: o.agent,
    inputs: {},
    worktreePath: o.h.worktreePath,
    templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: o.h.taskId },
    skills: [],
    appHome: o.h.appHome,
    runtime: 'claude-code',
    binaryOverride: ['bun', 'run', MOCK_CLAUDE],
    ...(o.runtimeParams ? { runtimeParams: o.runtimeParams } : {}),
    ...(o.log ? { log: o.log } : {}),
    db: o.h.db,
  })
}

async function waitForFirstRuntimeEvent(
  db: DbClient,
  nodeRunId: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await db
      .select({ id: nodeRunEvents.id })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .limit(1)
    if (rows.length > 0) return
    await Bun.sleep(10)
  }
  throw new Error('timed out waiting for Claude system/init persistence')
}

function captureWarnings(): {
  log: Logger
  warnings: Array<{ message: string; fields?: Record<string, unknown> }>
} {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) =>
      warnings.push(fields === undefined ? { message } : { message, fields }),
    error: () => {},
    child: () => log,
  }
  return { log, warnings }
}

describe('runNode — claude-code runtime (RFC-111 PR-B)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('happy path: stream-json envelope → outputs, status=done, session captured', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'claude says hi' }),
        MOCK_CLAUDE_SESSION_ID: 'claude-sess-xyz',
        MOCK_CLAUDE_INPUT_TOKENS: '12',
        MOCK_CLAUDE_OUTPUT_TOKENS: '4',
        MOCK_CLAUDE_CACHE_READ: '3',
      },
      () => runClaude({ agent, nodeRunId, h }),
    )
    expect(result.status).toBe('done')
    expect(result.exitCode).toBe(0)
    expect(result.outputs.summary).toBe('claude says hi')
    expect(result.sessionId).toBe('claude-sess-xyz')
    // tokens accumulated from the (single, cumulative) result event
    expect(result.tokenUsage.input).toBe(12)
    expect(result.tokenUsage.output).toBe(4)
    expect(result.tokenUsage.cacheRead).toBe(3)
    expect(result.tokenUsage.total).toBe(19)

    // sessionId capture is asserted on RunResult above; persistence to
    // node_runs.opencode_session_id is the scheduler's job (scheduler.ts), not
    // runNode's, so we only check the run status on the row here.
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    expect(row?.status).toBe('done')
  })

  test('system/init inventory is persisted while Claude is still running', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const releaseFile = join(h.appHome, 'release-claude-after-init')
    const runPromise = withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'inventory landed live' }),
        MOCK_CLAUDE_SESSION_ID: 'claude-live-inventory',
        MOCK_CLAUDE_INIT_INVENTORY: JSON.stringify({
          tools: ['Read', 'Write'],
          agents: ['general-purpose'],
          skills: ['lint'],
          mcp_servers: [{ name: 'rag', status: 'connected' }],
        }),
        MOCK_CLAUDE_WAIT_AFTER_INIT_UNTIL: releaseFile,
      },
      () => runClaude({ agent, nodeRunId, h }),
    )

    let inFlightRow: typeof nodeRuns.$inferSelect | undefined
    let observationError: unknown
    try {
      await waitForFirstRuntimeEvent(h.db, nodeRunId)
      inFlightRow = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
    } catch (err) {
      observationError = err
    } finally {
      writeFileSync(releaseFile, 'continue', 'utf-8')
    }

    const result = await runPromise
    if (observationError !== undefined) throw observationError
    expect(inFlightRow?.status).toBe('running')
    expect(inFlightRow?.runtimeInventoryJson).not.toBeNull()
    const observation: RuntimeInventoryObservation = JSON.parse(inFlightRow!.runtimeInventoryJson!)
    expect(observation.state).toBe('captured')
    if (observation.state === 'captured') {
      expect(observation.faces.tools?.map((item) => item.key)).toEqual(['Read', 'Write'])
      expect(observation.faces.agents?.map((item) => item.key)).toEqual(['general-purpose'])
      expect(observation.faces.skills?.map((item) => item.key)).toEqual(['lint'])
      expect(observation.faces.mcps?.map((item) => [item.key, item.status])).toEqual([
        ['rag', 'connected'],
      ])
    }
    expect(result.status).toBe('done')
  })

  test('an explicit root native id change without reset still fails closed', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const { log, warnings } = captureWarnings()
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'kept' }),
        MOCK_CLAUDE_SESSION_ID: 'claude-root-session',
        MOCK_CLAUDE_NON_INIT_SESSION_ID: 'claude-associated-session',
      },
      () => runClaude({ agent, nodeRunId, h, log }),
    )

    expect(result.status).toBe('failed')
    expect(result.failureCode).toBe('runtime-session-identity-invalid')
    expect(result.sessionId).toBeUndefined()
    expect(result.errorMessage).toContain(
      'runtime changed native session id without a conversation reset',
    )
    expect(
      warnings.find((entry) => entry.message === 'runtime-stream-pump-failed')?.fields
        ?.nativeSessionProtocolFailure,
    ).toEqual({
      reason: 'runtime changed native session id without a conversation reset',
      eventType: 'assistant',
      eventSubtype: null,
      hasParentToolUseId: false,
    })
    expect(
      h.db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .get(),
    ).toEqual({ sessionId: null })
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, 'claude-code'),
            eq(runtimeSessionLeases.sessionId, 'claude-root-session'),
          ),
        )
        .get(),
    ).toBeUndefined()
  })

  test('parallel subagent session ids stay event-local and do not interrupt the root run', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const childIds = ['claude-child-a', 'claude-child-b', 'claude-child-c']
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'root-complete' }),
        MOCK_CLAUDE_SESSION_ID: 'claude-parallel-root',
        MOCK_CLAUDE_PARALLEL_SUBAGENT_SESSION_IDS: JSON.stringify(childIds),
      },
      () => runClaude({ agent, nodeRunId, h }),
    )

    expect(result.status).toBe('done')
    expect(result.sessionId).toBe('claude-parallel-root')
    expect(result.outputs.summary).toBe('root-complete')
    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    for (const childId of childIds) {
      expect(rows.some((row) => row.payload.includes(childId))).toBe(true)
    }
    const frames = rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    const firstNotification = frames.findIndex(
      (frame) => frame.type === 'system' && frame.subtype === 'task_notification',
    )
    const startIndexes = frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.type === 'system' && frame.subtype === 'task_started')
      .map(({ index }) => index)
    expect(startIndexes).toHaveLength(childIds.length)
    expect(startIndexes.every((index) => index < firstNotification)).toBe(true)
    expect(
      frames
        .filter((frame) => frame.type === 'system' && frame.subtype === 'task_notification')
        .map((frame) => frame.session_id),
    ).toEqual([...childIds].reverse())
    expect(
      frames.some((frame) => frame.type === 'user' && typeof frame.parent_tool_use_id === 'string'),
    ).toBe(true)
    expect(rows.every((row) => row.sessionId === 'claude-parallel-root')).toBe(true)
  })

  test('conversation_reset rotates the durable lease to the next observed native id', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'kept' }),
        MOCK_CLAUDE_SESSION_ID: 'claude-before-reset',
        MOCK_CLAUDE_RESET_SESSION_ID: 'claude-after-reset',
        MOCK_CLAUDE_RESET_CONVERSATION_ID: 'ui-reset-correlation-only',
      },
      () => runClaude({ agent, nodeRunId, h }),
    )

    expect(result.status).toBe('done')
    expect(result.sessionId).toBe('claude-after-reset')
    expect(result.outputs.summary).toBe('kept')

    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const reset = rows.find((row) => row.payload.includes('"type":"conversation_reset"'))
    const assistant = rows.find((row) => row.payload.includes('"type":"assistant"'))
    const terminal = rows.find((row) => row.payload.includes('"type":"result"'))
    expect(reset?.sessionId).toBe('claude-after-reset')
    expect(reset?.payload).toContain('ui-reset-correlation-only')
    // The first explicit root turn after reset reveals the replacement id.
    // Rotation retags earlier root rows in one transaction so SessionTree has
    // one logical bucket, while raw payloads retain their original wire ids.
    expect(reset?.payload).toContain('"session_id":"claude-before-reset"')
    expect(assistant?.sessionId).toBe('claude-after-reset')
    expect(terminal?.sessionId).toBe('claude-after-reset')
    expect(rows.every((row) => row.sessionId === 'claude-after-reset')).toBe(true)

    expect(
      h.db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .get(),
    ).toEqual({ sessionId: 'claude-after-reset' })
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, 'claude-code'),
            eq(runtimeSessionLeases.sessionId, 'claude-before-reset'),
          ),
        )
        .get(),
    ).toBeUndefined()
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, 'claude-code'),
            eq(runtimeSessionLeases.sessionId, 'claude-after-reset'),
          ),
        )
        .get(),
    ).toEqual({ holder: null })
  })

  test('conversation_reset without a replacement never returns or persists the stale resume id', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        MOCK_CLAUDE_SESSION_ID: 'claude-invalidated-by-reset',
        MOCK_CLAUDE_RESET_SESSION_ID: 'unobserved-replacement',
        MOCK_CLAUDE_STOP_AFTER_RESET: '1',
      },
      () => runClaude({ agent, nodeRunId, h }),
    )

    expect(result.status).toBe('failed')
    expect(result.failureCode).toBe('runtime-stream-interrupted')
    expect(result.errorMessage).toContain(
      'runtime ended before reporting the replacement native session id',
    )
    expect(result.sessionId).toBeUndefined()
    expect(
      h.db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .get(),
    ).toEqual({ sessionId: null })
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, 'claude-code'),
            eq(runtimeSessionLeases.sessionId, 'claude-invalidated-by-reset'),
          ),
        )
        .get(),
    ).toBeUndefined()
  })

  test('argv contract: -p / stream-json / --append-system-prompt-file(=bodyMd) / --model', async () => {
    // RFC-113: --model now comes from the RUNTIME profile (runtimeParams), not
    // agent.model.
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const argvFile = join(h.appHome, 'argv.jsonl')
    const sysFile = join(h.appHome, 'sys.md')
    const promptFile = join(h.appHome, 'prompt.txt')
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_CLAUDE_CAPTURE_ARGV_TO: argvFile,
        MOCK_CLAUDE_CAPTURE_SYSTEM_PROMPT_TO: sysFile,
        MOCK_CLAUDE_CAPTURE_PROMPT_TO: promptFile,
      },
      () =>
        runClaude({
          agent,
          nodeRunId,
          h,
          runtimeParams: {
            model: 'opus',
            variant: null,
            temperature: null,
            steps: null,
            maxSteps: null,
            isSandbox: false,
          },
        }),
    )
    expect(result.status).toBe('done')
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8').trim()) as string[]
    expect(argv).toContain('-p')
    expect(argv.join(' ')).toContain('--output-format stream-json')
    expect(argv).toContain('--verbose')
    expect(argv.join(' ')).toContain('--permission-mode bypassPermissions')
    expect(argv.join(' ')).toContain('--model opus')
    expect(argv).toContain('--append-system-prompt-file')
    // persona = agent.bodyMd written to the system-prompt file (D6 append form)
    expect(readFileSync(sysFile, 'utf-8')).toBe('You are a Claude-driven test agent.')
    // prompt delivered over stdin (D12), equals the rendered user prompt
    expect(readFileSync(promptFile, 'utf-8')).toBe(result.prompt)
    expect(result.prompt).toContain('<workflow-output>')
  })

  test('agent omits --model when unset', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const argvFile = join(h.appHome, 'argv2.jsonl')
    await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_CLAUDE_CAPTURE_ARGV_TO: argvFile,
      },
      () => runClaude({ agent, nodeRunId, h }),
    )
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8').trim()) as string[]
    expect(argv).not.toContain('--model')
  })

  test('is_error result (exit 1) → status=failed', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv({ MOCK_CLAUDE_IS_ERROR: '1' }, () =>
      runClaude({ agent, nodeRunId, h }),
    )
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
  })

  test('stderr persistence exception is retained in Claude node diagnostics and logs', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const { log, warnings } = captureWarnings()
    await h.db.run(sql`
      CREATE TRIGGER fail_claude_stderr_event_insert
      BEFORE INSERT ON node_run_events
      WHEN NEW.kind = 'stderr'
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced Claude stderr persistence failure --token=claude-pump-secret'
        );
      END
    `)

    const result = await withEnv(
      {
        MOCK_CLAUDE_STDERR: 'trigger the stderr persistence path',
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'unreachable' }),
      },
      () => runClaude({ agent, nodeRunId, h, log }),
    )

    expect(result.status).toBe('failed')
    expect(result.failureCode).toBe('runtime-stream-interrupted')
    expect(result.errorMessage).toContain(
      'node-run-event/stderr: forced Claude stderr persistence failure',
    )
    expect(result.errorMessage).not.toContain('claude-pump-secret')

    const warning = warnings.find((entry) => entry.message === 'runtime-stream-pump-failed')
    expect(warning?.fields?.runtime).toBe('claude-code')
    expect(warning?.fields?.err).toContain('forced Claude stderr persistence failure')
    expect(warning?.fields?.err).not.toContain('claude-pump-secret')

    const row = h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
    expect(row?.status).toBe('failed')
    expect(row?.errorMessage).toBe(result.errorMessage)
  })
})

describe('runNode — claude injection parity (RFC-111 PR-C)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('mcp → --mcp-config; dependsOn closure → --agents; skill copied', async () => {
    const agent = makeAgent({ name: 'primary' })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    // a managed skill on disk
    const skillSrc = join(h.appHome, 'skill-src')
    mkdirSync(skillSrc, { recursive: true })
    writeFileSync(join(skillSrc, 'SKILL.md'), '# skill')
    const dep: Agent = makeAgent({ name: 'reviewer', bodyMd: 'You review.' })
    const argvFile = join(h.appHome, 'inj-argv.jsonl')
    const skillsCapFile = join(h.appHome, 'inj-skills.json')
    const result = await withEnv(
      {
        MOCK_CLAUDE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_CLAUDE_CAPTURE_ARGV_TO: argvFile,
        MOCK_CLAUDE_CAPTURE_SKILLS_TO: skillsCapFile,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'node1',
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [{ name: 'my-skill', sourceKind: 'managed', sourcePath: skillSrc }],
          dependents: [dep],
          mcps: [
            {
              name: 'fs',
              type: 'local',
              enabled: true,
              config: { command: ['npx', 'server'] },
            } as never,
          ],
          appHome: h.appHome,
          runtime: 'claude-code',
          binaryOverride: ['bun', 'run', MOCK_CLAUDE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('done')
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8').trim()) as string[]
    expect(argv).toContain('--mcp-config')
    expect(argv).not.toContain('--strict-mcp-config')
    expect(argv).toContain('--agents')
    // RFC-280 §7.1: --mcp-config now carries a 0600 FILE PATH under the
    // per-run dir (secrets off argv); the run has settled and the per-run dir
    // is cleaned, so assert the path shape here — content+mode are locked at
    // the spawn layer (rfc143-business-spawn).
    expect(argv[argv.indexOf('--mcp-config') + 1]!.endsWith('mcp-config.json')).toBe(true)
    const agentsJson = JSON.parse(argv[argv.indexOf('--agents') + 1]!) as Record<string, unknown>
    expect(agentsJson.reviewer).toBeDefined()
    // Managed skill is projected into the project-native .claude/skills path at
    // run time; the runner removes its entries afterwards, so the mock captures
    // it while the child is live.
    const injectedSkills = JSON.parse(readFileSync(skillsCapFile, 'utf-8')) as string[]
    expect(injectedSkills).toContain('my-skill')
  })
})

describe('runNode — runtime spawn failure (RFC-111 Codex P1-2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('missing runtime binary → status=failed (no throw, row not stranded running)', async () => {
    const agent = makeAgent()
    // pending row; runNode marks it running, then the bad binary fails the spawn.
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'node1',
      agent,
      inputs: {},
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      skills: [],
      appHome: h.appHome,
      runtime: 'claude-code',
      binaryOverride: ['/definitely/not/a/real/binary/claude-xyz'],
      db: h.db,
    })
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('spawn claude-code failed')
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    expect(row?.status).toBe('failed') // NOT stranded at 'running'
  })
})
