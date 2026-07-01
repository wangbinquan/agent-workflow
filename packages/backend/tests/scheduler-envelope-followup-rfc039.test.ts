// RFC-042 §A2 / §A6 / §5.5 — RFC-039 "Keep clarifying" strong-bias passthrough
// to the same-session follow-up prompt.
//
// The scheduler reads `clarifyContext?.directive` and threads it into runNode
// as `envelopeFollowupClarifyDirective`; the runner forwards it to
// `renderEnvelopeFollowupPrompt`. When the user clicked "Keep clarifying"
// (directive='continue'), the follow-up prompt must carry the RFC-039 strong
// bias short sentence; on stop (or absent directive), it must not.
//
// Covered at the runner level here because the full clarify-session resume
// path requires several scheduler-internal steps; the runner-level assertion
// validates exactly the contract the scheduler relies on without standing up
// the whole clarify flow.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'rfc039-agent',
    description: '',
    outputs: ['design'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'b',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function buildHarness() {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc042-rfc039-'))
  const worktreePath = join(appHome, 'wt')
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
    name: 'fixture',
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
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n', status: 'pending' })
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

describe('RFC-042 follow-up + RFC-039 directive bias passthrough', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('hasClarifyChannel=true + directive=continue → followup prompt carries "Keep clarifying"', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }) }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n',
        agent: makeAgent(),
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        promptTemplate: 'go',
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        envelopeFollowup: true,
        envelopeFollowupReason: 'envelope-missing',
        envelopeFollowupClarifyDirective: 'continue',
        hasClarifyChannel: true,
        resumeSessionId: 'opc_continue',
      }),
    )
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    const prompt = row?.promptText ?? ''
    expect(prompt).toContain('Keep clarifying')
    expect(prompt).toContain('MUST be another `<workflow-clarify>` envelope')
  })

  test('hasClarifyChannel=true + directive=stop → followup prompt does NOT contain "Keep clarifying"', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }) }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n',
        agent: makeAgent(),
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        promptTemplate: 'go',
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        envelopeFollowup: true,
        envelopeFollowupReason: 'envelope-missing',
        envelopeFollowupClarifyDirective: 'stop',
        hasClarifyChannel: true,
        resumeSessionId: 'opc_stop',
      }),
    )
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    const prompt = row?.promptText ?? ''
    expect(prompt).not.toContain('Keep clarifying')
    expect(prompt).not.toContain('MUST be another `<workflow-clarify>` envelope')
    // RFC-100: the mandatory ask-back body still appears (clarify channel is wired).
    expect(prompt).toContain('MANDATORY ask-back mode')
  })
})
