// RFC-023 PR-B T10 — runner envelope-kind branching.
//
// Validates that runner.runNode pivots on detectEnvelopeKind:
//   - 'output'   → legacy happy path (already covered by runner.test.ts)
//   - 'clarify'  → result.clarify is populated; outputs is empty; status=done
//   - 'both'     → status=failed with 'clarify-and-output-both-present'
//   - 'none'     → status=failed with 'envelope' error message
//
// Also exercises the protocol-block wire-up: when opts.hasClarifyChannel is
// true, the user prompt contains the buildClarifyProtocolBlock() text so the
// agent reads the rules; when false, the standard output-only block is the
// only protocol block present.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: ulid(),
    name: 'asker',
    description: 'an agent that may clarify',
    outputs: ['summary'],
    readonly: true,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    frontmatterExtra: {},
    bodyMd: 'You may ask back.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-runner-clarify-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
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

async function insertPendingNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'asker', status: 'pending' })
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

describe('runNode envelope branching (RFC-023)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('clarify-only envelope: status=done, result.clarify populated, outputs empty', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const clarifyBody = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 'Pick a DB?',
          kind: 'single',
          recommended: true,
          options: ['Postgres', 'MySQL'],
        },
      ],
    })

    const result = await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: clarifyBody,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          hasClarifyChannel: true,
        }),
    )

    expect(result.status).toBe('done')
    expect(result.outputs).toEqual({})
    expect(result.clarify).toBeDefined()
    expect(result.clarify?.questions).toHaveLength(1)
    expect(result.clarify?.questions[0]?.id).toBe('q1')
    // The clarify protocol block must be in the prompt when hasClarifyChannel=true
    expect(result.prompt).toContain('Clarify mode is enabled')
  })

  test('both envelopes: status=failed with clarify-and-output-both-present', async () => {
    const agent = makeAgent({ outputs: ['summary'] })
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const clarifyBody = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 'Why?',
          kind: 'single',
          recommended: false,
          options: ['A', 'B'],
        },
      ],
    })
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'hedged' }),
        MOCK_OPENCODE_CLARIFY_BODY: clarifyBody,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          hasClarifyChannel: true,
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('clarify-and-output-both-present')
    expect(result.clarify).toBeUndefined()
  })

  test('clarify envelope with body that parses but contains hard error → status=failed with code prefix', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    // options length 1 is below the MIN of 2 — parseClarifyEnvelopeBody rejects.
    const clarifyBody = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 'Bad?',
          kind: 'single',
          recommended: false,
          options: ['only-one'],
        },
      ],
    })
    const result = await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: clarifyBody }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        hasClarifyChannel: true,
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('clarify-options-too-few')
  })

  test('protocol block omitted when hasClarifyChannel=false', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        // hasClarifyChannel omitted (defaults to undefined)
      }),
    )
    expect(result.status).toBe('done')
    expect(result.prompt).not.toContain('Clarify mode is enabled')
  })

  test('clarify envelope with too many options/questions: parsed body keeps the limits + warnings live in log only', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const clarifyBody = JSON.stringify({
      // 6 questions → truncated to 5; each with 5 options → truncated to 4.
      questions: [1, 2, 3, 4, 5, 6].map((i) => ({
        id: `q${i}`,
        title: `Question ${i}`,
        kind: 'single',
        recommended: false,
        options: ['A', 'B', 'C', 'D', 'E'],
      })),
    })
    const result = await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: clarifyBody }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        hasClarifyChannel: true,
      }),
    )
    expect(result.status).toBe('done')
    expect(result.clarify?.questions.length).toBe(5)
    expect(result.clarify?.questions.every((q) => q.options.length === 4)).toBe(true)
    expect(result.clarify?.truncationWarnings.length).toBeGreaterThan(0)
  })
})
