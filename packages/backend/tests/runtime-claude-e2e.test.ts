// RFC-111 PR-B — end-to-end runNode against the claude-code runtime via the
// mock-claude harness (no real API). Locks the claude headless contract:
// argv (-p / --output-format stream-json / --append-system-prompt-file / --model
// / --disallowed-tools), prompt-over-stdin (D12), persona = agent.bodyMd in the
// system-prompt file (D6), stream-json envelope → outputs, session capture,
// token accumulation from the result event, and is_error/exit → failed.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

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
    readonly: true,
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
    opencodeCmd: ['bun', 'run', MOCK_CLAUDE],
    db: o.h.db,
  })
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

  test('argv contract: -p / stream-json / --append-system-prompt-file(=bodyMd) / --model / --disallowed-tools', async () => {
    const agent = makeAgent({ model: 'opus', readonly: true })
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
      () => runClaude({ agent, nodeRunId, h }),
    )
    expect(result.status).toBe('done')
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8').trim()) as string[]
    expect(argv).toContain('-p')
    expect(argv.join(' ')).toContain('--output-format stream-json')
    expect(argv).toContain('--verbose')
    expect(argv.join(' ')).toContain('--permission-mode bypassPermissions')
    expect(argv.join(' ')).toContain('--model opus')
    expect(argv).toContain('--append-system-prompt-file')
    expect(argv).toContain('--disallowed-tools') // readonly agent
    // persona = agent.bodyMd written to the system-prompt file (D6 append form)
    expect(readFileSync(sysFile, 'utf-8')).toBe('You are a Claude-driven test agent.')
    // prompt delivered over stdin (D12), equals the rendered user prompt
    expect(readFileSync(promptFile, 'utf-8')).toBe(result.prompt)
    expect(result.prompt).toContain('<workflow-output>')
  })

  test('non-readonly agent omits --disallowed-tools; no --model when unset', async () => {
    const agent = makeAgent({ readonly: false, model: undefined })
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
    expect(argv).not.toContain('--disallowed-tools')
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
})
