// RFC-060 PR-D D.T7 — runner rejects signal-port references in promptTemplate.
//
// When opts.inputPortKinds[port] is the `signal` kind and the promptTemplate
// contains `{{port}}`, runner must:
//   - Persist node_run.status='failed' (RFC-053 mark-failed transition)
//   - Return errorMessage prefixed with 'signal-port-in-prompt'
//   - Skip spawning opencode entirely (no need to mock the subprocess)
//
// Locks the cross-package wire: shared/signalPromptGuard.assertNoPromptSignalRefs
// runs inside runner.ts before render. Companion source-text lock in
// scheduler-wrapper-fanout-routing.test.ts (D.T7 section).

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
    name: 'sample-agent',
    description: 'fixture',
    outputs: ['result'],
    readonly: true,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-signal-prompt-'))
  const worktreePath = join(appHome, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] }),
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

async function insertPendingNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'sample-agent', status: 'pending' })
  return id
}

describe('D.T7 — runNode signal-port-in-prompt guard', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test("template '{{control}}' with inputPortKinds.control='signal' → status=failed with signal-port-in-prompt", async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'sample-agent',
      agent,
      inputs: { control: '' },
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      promptTemplate: 'go: {{control}}',
      inputPortKinds: { control: 'signal' },
      skills: [],
      appHome: h.appHome,
      // No opencodeCmd needed — runner must bail before spawn.
      db: h.db,
    })
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('signal-port-in-prompt')
    expect(result.errorMessage).toContain('control')

    // node_runs row should reflect the failed status (RFC-053 lifecycle).
    const rows = await h.db.select().from(nodeRuns)
    const row = rows.find((r) => r.id === nodeRunId)
    expect(row?.status).toBe('failed')
  })

  test('template referencing a non-signal port passes the guard', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    // We use a bogus opencodeCmd so the run still fails (no real spawn) — but
    // failure comes from the spawn, NOT from signal-port-in-prompt. That's the
    // distinction we need to lock in.
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'sample-agent',
      agent,
      inputs: { doc: 'hello' },
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      promptTemplate: 'go: {{doc}}',
      inputPortKinds: { doc: 'string' },
      skills: [],
      appHome: h.appHome,
      opencodeCmd: ['bash', '-c', 'exit 7'], // immediate non-zero exit
      db: h.db,
    })
    expect(result.errorMessage ?? '').not.toContain('signal-port-in-prompt')
  })

  test('inputPortKinds undefined → guard is skipped (legacy behavior preserved)', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    // No inputPortKinds; runner should NOT raise the signal guard even if
    // a template happens to reference a port. Use bogus opencodeCmd so we
    // get a non-signal failure path.
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'sample-agent',
      agent,
      inputs: { stub: '' },
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      promptTemplate: 'go: {{stub}}',
      skills: [],
      appHome: h.appHome,
      opencodeCmd: ['bash', '-c', 'exit 7'],
      db: h.db,
    })
    expect(result.errorMessage ?? '').not.toContain('signal-port-in-prompt')
  })

  test('multiple signal ports referenced → errorMessage lists all', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'sample-agent',
      agent,
      inputs: { a: '', b: '' },
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      promptTemplate: '{{a}} then {{b}}',
      inputPortKinds: { a: 'signal', b: 'signal' },
      skills: [],
      appHome: h.appHome,
      db: h.db,
    })
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('signal-port-in-prompt')
    expect(result.errorMessage).toContain('a')
    expect(result.errorMessage).toContain('b')
  })

  test('template referencing port without any portKind set → guard passes (default = not signal)', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'sample-agent',
      agent,
      inputs: { only: '' },
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      // template references {{only}}, inputPortKinds map omits 'only' → ok.
      promptTemplate: 'go: {{only}}',
      inputPortKinds: { other: 'signal' },
      skills: [],
      appHome: h.appHome,
      opencodeCmd: ['bash', '-c', 'exit 7'],
      db: h.db,
    })
    expect(result.errorMessage ?? '').not.toContain('signal-port-in-prompt')
  })
})
