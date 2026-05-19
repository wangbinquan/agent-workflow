// RFC-049 — locks the runner's eager port-content validation path.
//
// Scenario: agent emits a `<workflow-output>` envelope whose markdown_file
// port content does NOT point to a real file on disk. With outputKinds
// declared on the agent, the runner must:
//   1. Parse the envelope OK (XML happy path).
//   2. Eagerly resolve each declared-kind port via the OutputKindHandler
//      registered for that kind — the markdown_file handler tries to read the
//      file, which here fails (missing-file subReason).
//   3. Translate the failure into a PortValidationError, captured into the
//      `portValidationFailures` list.
//   4. Mark status=failed, errorMessage to the namespaced
//      `port-validation-markdown_file-missing-file: ...` form.
//   5. Persist the structured failures payload to
//      `node_runs.port_validation_failures_json` (JSON array).
//
// The complementary "happy path" lock: when the agent ALSO writes the file
// to disk first, the same envelope succeeds and the new column stays NULL.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
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

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: '',
    outputs: ['docpath'],
    outputKinds: { docpath: 'markdown_file' },
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
  } as Agent
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc049-eager-'))
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
    id: taskId,
    name: 'fixture-task',
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
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    clarifyIteration: 0,
  })
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
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
}

describe('RFC-049 runner eager port-validation', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('markdown_file port content points to missing file → status=failed + new column populated', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ docpath: 'report.md' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('port-validation-markdown_file-missing-file')
    expect(result.errorMessage).toContain("'report.md'")

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.status).toBe('failed')
    expect(row.portValidationFailuresJson).not.toBeNull()
    const parsed = JSON.parse(row.portValidationFailuresJson!) as Array<{
      port: string
      kind: string
      subReason: string
      detail?: string
    }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.port).toBe('docpath')
    expect(parsed[0]!.kind).toBe('markdown_file')
    expect(parsed[0]!.subReason).toBe('missing-file')
    expect(parsed[0]!.detail).toContain("'report.md'")
  })

  test('markdown_file port content + file actually on disk → status=done, column stays NULL', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    // Agent commits to writing the file behind the path.
    writeFileSync(join(h.worktreePath, 'report.md'), '# Report\nbody')
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ docpath: 'report.md' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('done')

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.status).toBe('done')
    expect(row.portValidationFailuresJson).toBeNull()
  })

  test('markdown_file port content has wrong extension → wrong-extension subReason captured', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    writeFileSync(join(h.worktreePath, 'report.txt'), '# text')
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ docpath: 'report.txt' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('port-validation-markdown_file-wrong-extension')

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    const parsed = JSON.parse(row.portValidationFailuresJson!) as Array<{ subReason: string }>
    expect(parsed[0]!.subReason).toBe('wrong-extension')
  })

  test('markdown_file file exists but content trims to empty → empty-file subReason', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    writeFileSync(join(h.worktreePath, 'blank.md'), '   \n\n   ')
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ docpath: 'blank.md' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('port-validation-markdown_file-empty-file')

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    const parsed = JSON.parse(row.portValidationFailuresJson!) as Array<{ subReason: string }>
    expect(parsed[0]!.subReason).toBe('empty-file')
  })
})
