// RFC-049 — scheduler integration for same-session port-validation follow-up.
//
// End-to-end smoke against mock-opencode. The agent emits a markdown_file
// port whose path is never persisted on disk; the runner's eager
// resolvePortContent throws PortValidationError, the scheduler reads back
// the structured failures, schedules a same-session follow-up attempt,
// inserts a `[rfc049/port-validation-followup]` audit row, and passes
// `--session <id>` to the next opencode spawn.
//
// We don't simulate a "second attempt succeeds" path here — the value of
// this integration is to lock the failure → audit → resume contract; the
// per-port repair prompt content is covered separately in the runner unit
// + shared followup-prompt suites.

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
  argvLog: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc049-sched-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    argvLog,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'rfc-049',
    outputs: JSON.stringify(['design']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify({ outputKinds: { design: 'markdown_file' } }),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
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

describe('RFC-049 scheduler port-validation follow-up integration', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('eager port-validation failure → audit row + --session on retry', async () => {
    const agentId = await seedAgent(h.db, 'a1')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentId, agentName: 'a1' }],
      edges: [],
    }
    const { taskId } = await seedTask(h, def)
    await withEnv(
      {
        // Both attempts emit the envelope with a path that points nowhere on
        // disk — the runner will throw PortValidationError both times.
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'report.md' }),
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc049_resume',
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          // RFC-115: retry budget via runTask opts (was node.retries: 1).
          defaultNodeRetries: 1,
        }),
    )

    // Task ends failed (both attempts hit the same missing-file failure).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')

    const runRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runRows.length).toBe(2)
    const attempt0 = runRows.find((r) => r.retryIndex === 0)
    const attempt1 = runRows.find((r) => r.retryIndex === 1)
    expect(attempt0).toBeTruthy()
    expect(attempt1).toBeTruthy()

    // Attempt 0: failed with port-validation prefix + structured failures column.
    expect(attempt0!.status).toBe('failed')
    // RFC-080 (D2): markdown_file folds to path<md> → namespace is `path`.
    expect(attempt0!.errorMessage).toContain('port-validation-path-missing-file')
    expect(attempt0!.portValidationFailuresJson).not.toBeNull()
    const parsed = JSON.parse(attempt0!.portValidationFailuresJson!) as Array<{
      port: string
      kind: string
      subReason: string
    }>
    expect(parsed[0]!.port).toBe('design')
    expect(parsed[0]!.kind).toBe('markdown_file')
    expect(parsed[0]!.subReason).toBe('missing-file')

    // Audit event lands on attempt 1's row (the fresh row for the followup
    // attempt), NOT on attempt 0.
    const events1 = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, attempt1!.id))
    const audit = events1.find((e) => e.payload.includes('[rfc049/port-validation-followup]'))
    expect(audit).toBeTruthy()
    expect(audit?.payload).toContain('"kind":"markdown_file"')
    expect(audit?.payload).toContain('"subReason":"missing-file"')
    expect(audit?.payload).toContain('"port":"design"')

    // Argv log: attempt 0 had no --session, attempt 1 carried --session opc_rfc049_resume.
    const argvs = readArgvLog(h.argvLog)
    expect(argvs.length).toBe(2)
    expect(argvs[0]).not.toContain('--session')
    const idx = argvs[1]!.indexOf('--session')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argvs[1]![idx + 1]).toBe('opc_rfc049_resume')
  })
})
