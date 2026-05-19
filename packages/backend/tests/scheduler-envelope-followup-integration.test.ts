// RFC-042 — scheduler integration for same-session envelope follow-up.
//
// Drives runTask end-to-end against mock-opencode and asserts that on each
// retry the scheduler picks the right branch based on the prior attempt:
//   - clean exit + missing envelope + captured session id + ≥ 1 text line
//     → next attempt runs with `--session <id>` (same-session follow-up)
//   - non-zero exit / no session captured / no text → fresh-session retry
//     (no `--session` in argv).
//
// Plus the absent / explicit `retries` field tests for the new default = 3.
// Maps to design.md §5.2 cases 9-12 + §5.4 cases.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  counterFile: string
  argvLog: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc042-sched-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const counterFile = join(appHome, 'counter')
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    counterFile,
    argvLog,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[] = ['design']) {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'rfc-042',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
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

function readArgvLog(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).argv as string[])
}

describe('RFC-042 scheduler envelope follow-up integration', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  // §5.2 case 9
  test('clean exit + missing envelope → next attempt resumes the SAME session', async () => {
    await seedAgent(h.db, 'a1')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a1', retries: 1 }],
      edges: [],
    }
    const { taskId } = await seedTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc042_resume',
        MOCK_OPENCODE_FAIL_COUNTER: h.counterFile,
        MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL: '1',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'recovered' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const argvs = readArgvLog(h.argvLog)
    expect(argvs.length).toBe(2)
    expect(argvs[0]).not.toContain('--session')
    const idx = argvs[1]!.indexOf('--session')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argvs[1]![idx + 1]).toBe('opc_rfc042_resume')
    // The audit event row is present on the SECOND row.
    const runRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const secondRow = runRows.find((r) => r.retryIndex === 1)
    expect(secondRow).toBeTruthy()
    const events = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, secondRow!.id))
    const audit = events.find((e) => e.payload.includes('[rfc042/envelope-followup]'))
    expect(audit).toBeTruthy()
    expect(audit?.payload).toContain('"reason":"envelope-missing"')
  })

  // §5.2 case 10
  test('non-zero exit + missing envelope → retry without --session (fresh session)', async () => {
    await seedAgent(h.db, 'a1')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a1', retries: 1 }],
      edges: [],
    }
    const { taskId } = await seedTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc042_crash',
        MOCK_OPENCODE_EXIT_CODE: '7',
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const argvs = readArgvLog(h.argvLog)
    // attempt 0 + 1 retry = 2 invocations, neither carries --session
    expect(argvs.length).toBe(2)
    for (const a of argvs) {
      expect(a).not.toContain('--session')
    }
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
  })

  // §5.2 case 11
  test('retries=0 prevents follow-up entirely', async () => {
    await seedAgent(h.db, 'a1')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a1', retries: 0 }],
      edges: [],
    }
    const { taskId } = await seedTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc042_no_retry',
        MOCK_OPENCODE_FAIL_COUNTER: h.counterFile,
        MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL: '5',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const argvs = readArgvLog(h.argvLog)
    expect(argvs.length).toBe(1)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
  })

  // §5.2 case 12
  test('all retries exhausted without producing an envelope → task fails, every retry uses --session', async () => {
    await seedAgent(h.db, 'a1')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a1', retries: 3 }],
      edges: [],
    }
    const { taskId } = await seedTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc042_exhaust',
        MOCK_OPENCODE_FAIL_COUNTER: h.counterFile,
        MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL: '99',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const argvs = readArgvLog(h.argvLog)
    expect(argvs.length).toBe(4)
    // attempt 0 = no session; attempts 1-3 all carry --session
    expect(argvs[0]).not.toContain('--session')
    for (let i = 1; i < argvs.length; i++) {
      const idx = argvs[i]!.indexOf('--session')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(argvs[i]![idx + 1]).toBe('opc_rfc042_exhaust')
    }
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('envelope')
  })
})
