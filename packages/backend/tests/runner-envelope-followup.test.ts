// RFC-042 T3 — runner envelope-followup wiring (RFC-148: the scattered
// envelopeFollowup* fields are now the `promptMode` followup arm).
//
// Locks in:
//   1. promptMode { kind:'followup', resumeSessionId:'opc_xxx' } threads
//      `--session opc_xxx` through to the subprocess (RFC-026 transport
//      reused) — the session rides INSIDE the followup arm.
//   2. The promptText persisted to node_runs is the short
//      renderEnvelopeFollowupPrompt body — NOT the full renderUserPrompt with
//      inputs / template body / RFC-039 protocol block. (Same-session resume
//      already has all of that in opencode's session memory.)
//   3. A followup dispatch skips RFC-029 inventory plugin materialization
//      (the first attempt already wrote the snapshot; the follow-up is
//      strictly about getting an envelope out).
//   4. RFC-148 设计门 D2: "followup without a session" is unrepresentable —
//      the followup arm's `resumeSessionId` is mandatory, so constructing a
//      followup dispatch ALWAYS puts `--session` on argv (the historical
//      defensive "argv simply lacks --session" misuse test is replaced by
//      the positive assertion).

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, runtimeSessionLeases, tasks, workflows } from '../src/db/schema'
import { runNode } from './helpers/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  argvLog: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'followup-agent',
    description: 'rfc-042 fixture',
    outputs: ['design'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You are a test agent.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc042-runner-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
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
    argvLog,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return id
}

function seedReleasedSession(db: DbClient, taskId: string, sessionId: string): void {
  db.insert(runtimeSessionLeases)
    .values({
      protocol: 'opencode',
      sessionId,
      taskId,
      nodeId: 'n1',
      createdNodeRunId: `prior-${sessionId}`,
    })
    .run()
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

describe('RFC-042 runner envelope followup (promptMode followup arm)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('threads --session <id> through when promptMode is the followup arm', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    seedReleasedSession(h.db, h.taskId, 'opc_followup_test_01')
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent,
          inputs: { spec: 'a real input value the followup must not re-emit' },
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          promptTemplate: 'BUILD {{spec}}',
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          promptMode: {
            kind: 'followup',
            resumeSessionId: 'opc_followup_test_01',
            reason: 'envelope-missing',
          },
        }),
    )
    const argvLines = readFileSync(h.argvLog, 'utf8').trim().split('\n').filter(Boolean)
    expect(argvLines.length).toBe(1)
    const argv = JSON.parse(argvLines[0]!).argv as string[]
    const idx = argv.indexOf('--session')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('opc_followup_test_01')
  })

  test('followup promptText is the short follow-up — no inputs / template body / protocol block', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    seedReleasedSession(h.db, h.taskId, 'opc_followup_test_02')
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }) }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n1',
        agent,
        inputs: { spec: 'UNIQUE_INPUT_PAYLOAD_THAT_MUST_NOT_LEAK_INTO_FOLLOWUP' },
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        promptTemplate: 'TEMPLATE_BODY_THAT_MUST_NOT_LEAK_{{spec}}',
        skills: [],
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        promptMode: {
          kind: 'followup',
          resumeSessionId: 'opc_followup_test_02',
          reason: 'envelope-missing',
        },
      }),
    )
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    const prompt = row?.promptText ?? ''
    // Followup prompt body must be present.
    expect(prompt).toContain('Envelope missing — follow-up.')
    expect(prompt).toContain('<workflow-output>')
    // The full prompt's content MUST NOT appear.
    expect(prompt).not.toContain('UNIQUE_INPUT_PAYLOAD_THAT_MUST_NOT_LEAK_INTO_FOLLOWUP')
    expect(prompt).not.toContain('TEMPLATE_BODY_THAT_MUST_NOT_LEAK_')
    // The legacy protocol block (`renderUserPrompt` trailing) must not appear.
    expect(prompt).not.toContain('You MUST end your reply with a `<workflow-output>` block listing')
  })

  test('followup promptMode skips inventory-plugin materialization', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    seedReleasedSession(h.db, h.taskId, 'opc_followup_test_03')
    // The runner caches the materialized plugin under runs/<task>/<run>/aw-inventory-dump.mjs.
    // When followup is on, that file must NOT be created.
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }) }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n1',
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        promptTemplate: 'go',
        skills: [],
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        promptMode: {
          kind: 'followup',
          resumeSessionId: 'opc_followup_test_03',
          reason: 'envelope-missing',
        },
        nodeKind: 'agent-single',
      }),
    )
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    // inventory_snapshot_json must be NULL on followup runs (we explicitly
    // skipped materialization, so no snapshot path is set / no read attempt
    // is made → column stays NULL).
    expect(row?.inventorySnapshotJson ?? null).toBeNull()
  })

  test('D2: a followup dispatch always carries --session, sourced from the followup arm', async () => {
    // RFC-148 设计门 D2 修订：这条用例历史上锁的是「envelopeFollowup=true 而无
    // resumeSessionId 也能跑（argv 缺 --session）」的防御行为。该状态已随
    // promptMode 判别联合变为不可表示（followup 臂的 resumeSessionId 必填——
    // 编译期锁见 rfc148-adt-contracts.test.ts），因此改为正向断言：构造
    // followup 臂必然携带 session，argv 必然带 --session；且 runner 从
    // followup 臂取 session——即便遗留的顶层 resumeSessionId（inline-resume
    // 专用字段）同时在场，臂内值仍是权威来源。
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    seedReleasedSession(h.db, h.taskId, 'opc_followup_arm_session')
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'OK' }),
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
          promptTemplate: 'go',
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          promptMode: {
            kind: 'followup',
            resumeSessionId: 'opc_followup_arm_session',
            reason: 'envelope-missing',
          },
          // Stale top-level inline-resume field — must NOT win over the arm.
          resumeSessionId: 'opc_stale_toplevel',
        }),
    )
    const argvLines = readFileSync(h.argvLog, 'utf8').trim().split('\n').filter(Boolean)
    expect(argvLines.length).toBe(1)
    const argv = JSON.parse(argvLines[0]!).argv as string[]
    const idx = argv.indexOf('--session')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('opc_followup_arm_session')
  })
})
