// RFC-073 T7 — integration: the deadlock-preventing global permission +
// per-agent question strip ACTUALLY reach the spawned opencode subprocess
// (buildInlineConfig → OPENCODE_CONFIG_CONTENT env-var → child), not just
// buildInlineConfig's return value (which runner-permission-inject.test.ts
// already locks at the unit level). This catches an integration regression
// where buildInlineConfig grows the field but runNode drops/overwrites it
// before spawn.
//
// SCOPE NOTE (honest boundary): this does NOT exercise real opencode's
// evaluate()/Permission.disabled() runtime behavior — that a global
// `{"*":"allow","question":"deny"}` makes permission.asked never fire and
// strips the question tool. That is verified by source review (see
// design/RFC-073.../design.md §0.2, citing opencode permission/evaluate.ts:14,
// agent/agent.ts:124/290, session/llm.ts:439-444) and, optionally, by the
// env-gated live suite in integration-opencode/. Here we lock the
// framework-side contract: the config is serialized into the child's env with
// the load-bearing key order + the anti-revival strip intact.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(permission: Record<string, unknown> = {}): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: '',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission,
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc073-runner-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
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
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
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

/** Spawn the mock opencode via runNode and return the RAW config string it saw. */
async function captureSpawnedConfig(h: Harness, agent: Agent): Promise<string> {
  const nodeRunId = await insertNodeRun(h.db, h.taskId)
  const capturePath = join(h.appHome, `cfg-${nodeRunId}.json`)
  await withEnv(
    {
      MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO: capturePath,
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      // Keep post-run subagent capture off the developer's real opencode DB.
      OPENCODE_TEST_HOME: join(h.appHome, 'fake-home'),
    },
    () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n1',
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
      }),
  )
  return readFileSync(capturePath, 'utf-8')
}

describe('RFC-073 global permission reaches the spawned opencode subprocess', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('top-level permission {"*":"allow","question":"deny"} is in the child OPENCODE_CONFIG_CONTENT', async () => {
    const raw = await captureSpawnedConfig(h, makeAgent())
    const cfg = JSON.parse(raw) as { permission?: Record<string, string> }
    expect(cfg.permission).toEqual({ '*': 'allow', question: 'deny' })
  })

  test('LOAD-BEARING key order survives end-to-end: "question" after "*" in the raw child config', async () => {
    // If a refactor reorders the object literal, opencode's Permission.disabled
    // (findLast) would resolve `question` to {*,allow} and stop disabling it,
    // silently re-opening the question.asked deadlock. Lock the order on the
    // exact bytes the child receives, not just buildInlineConfig's return.
    const raw = await captureSpawnedConfig(h, makeAgent())
    expect(raw.indexOf('"question"')).toBeGreaterThan(raw.indexOf('"*"'))
  })

  test('anti-revival end-to-end: an agent\'s own question:"allow" is stripped before reaching the child', async () => {
    const raw = await captureSpawnedConfig(h, makeAgent({ question: 'allow', bash: 'allow' }))
    const cfg = JSON.parse(raw) as {
      agent: Record<string, { permission?: Record<string, unknown> }>
    }
    const entryPerm = cfg.agent['test-agent']!.permission ?? {}
    expect('question' in entryPerm).toBe(false)
    // sibling keys in the agent's own permission survive
    expect(entryPerm.bash).toBe('allow')
    // ...and the global question:deny is still present at the top level
    expect((cfg as unknown as { permission: Record<string, string> }).permission.question).toBe(
      'deny',
    )
  })
})
