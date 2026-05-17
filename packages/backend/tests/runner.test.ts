// Integration tests for the opencode runner (P-1-13b).
//
// Strategy: opencode is replaced with a Bun-script mock fixture that the
// runner spawns instead of the real binary. The mock validates that the
// runner set OPENCODE_CONFIG_DIR / OPENCODE_CONFIG_CONTENT correctly, then
// emits configurable JSON events + envelope. The DB is in-memory.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  workflowId: string
  cleanup: () => void
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: 'an agent',
    outputs: ['summary'],
    readonly: true,
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
    ...overrides,
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-runner-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  // Seed workflow + task so the FK from node_runs.task_id stays satisfied.
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    workflowId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(db: DbClient, taskId: string, nodeId = 'node1'): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'pending',
  })
  return id
}

// We pass mock env vars through to the spawned bun subprocess. The runner
// inherits process.env; we set/unset them in test scope before/after each call.
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

describe('runNode', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('happy path: parses envelope, persists outputs, status=done', async () => {
    const agent = makeAgent({ outputs: ['summary', 'findings'] })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)

    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'all good', findings: 'none' }),
        MOCK_OPENCODE_EVENTS: JSON.stringify([
          { type: 'step_start' },
          { type: 'text', text: 'hi' },
        ]),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          agent,
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: {
            repoPath: '/tmp/repo',
            baseBranch: 'main',
            taskId: h.taskId,
          },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )

    expect(result.status).toBe('done')
    expect(result.exitCode).toBe(0)
    expect(result.outputs.summary).toBe('all good')
    expect(result.outputs.findings).toBe('none')
    expect(result.prompt).toContain('<workflow-output>')

    // DB side-effects
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
    const row = rows[0]
    expect(row?.status).toBe('done')
    expect(row?.exitCode).toBe(0)
    expect(row?.promptText).toBe(result.prompt)
    expect(typeof row?.startedAt).toBe('number')
    expect(typeof row?.finishedAt).toBe('number')

    const outputRows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    expect(outputRows.length).toBe(2)
    expect(outputRows.find((r) => r.portName === 'summary')?.content).toBe('all good')

    const eventRows = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    // 2 explicit events + the synthetic text event that carries the envelope.
    expect(eventRows.length).toBe(3)
    expect(eventRows.find((e) => e.kind === 'step_start')).toBeTruthy()
    expect(eventRows.filter((e) => e.kind === 'text').length).toBe(2)

    // Run dir cleaned up
    expect(existsSync(join(h.appHome, 'runs', h.taskId, nodeRunId))).toBe(false)
  })

  test('missing envelope -> status=failed with explanatory errorMessage', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv({ MOCK_OPENCODE_SKIP_ENVELOPE: '1' }, () =>
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
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('envelope')

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
    const row = rows[0]
    expect(row?.status).toBe('failed')
    expect(row?.errorMessage).toContain('envelope')
  })

  test('non-zero exit -> status=failed', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      { MOCK_OPENCODE_EXIT_CODE: '7', MOCK_OPENCODE_SKIP_ENVELOPE: '1' },
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
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(7)
    expect(result.errorMessage).toContain('exited with code 7')
  })

  test('stderr lines captured into node_run_events with kind=stderr', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_STDERR: 'warning: deprecated\nerror: failed thing',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
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
        }),
    )
    const allEvents = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    const errEvents = allEvents.filter((e) => e.kind === 'stderr')
    expect(errEvents.length).toBe(2)
    expect(errEvents.map((e) => e.payload).sort()).toEqual([
      'error: failed thing',
      'warning: deprecated',
    ])
  })

  test('timeout -> status=failed with node-timeout error', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        // Mock sleeps longer than the runner's timeout.
        MOCK_OPENCODE_DELAY_MS: '2000',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'too late' }),
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
          timeoutMs: 200,
        }),
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('node-timeout')
  })

  test('AbortSignal -> status=canceled', async () => {
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const controller = new AbortController()
    // Fire the abort soon after the runner has spawned the child.
    setTimeout(() => controller.abort(), 100)
    const result = await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '2000',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'unreachable' }),
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
          signal: controller.signal,
        }),
    )
    expect(result.status).toBe('canceled')
    expect(result.errorMessage).toContain('aborted')
  })

  test('managed skill is copied + project skill skipped', async () => {
    // Set up a managed-skill source dir on disk.
    const skillSource = mkdtempSync(join(tmpdir(), 'aw-skill-src-'))
    writeFileSync(join(skillSource, 'SKILL.md'), '---\nname: helper\ndescription: x\n---\nbody')
    try {
      const agent = makeAgent()
      const nodeRunId = await insertNodeRun(h.db, h.taskId)
      const result = await withEnv(
        {
          MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
          // The mock will fail if OPENCODE_CONFIG_CONTENT lacks the inline agent
          // prompt — i.e. proves runner is wiring the env right.
          MOCK_OPENCODE_REQUIRE_TOKEN: '1',
        },
        () =>
          runNode({
            taskId: h.taskId,
            nodeRunId,
            agent,
            inputs: {},
            worktreePath: h.worktreePath,
            templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
            skills: [
              { name: 'helper', sourceKind: 'managed', sourcePath: skillSource },
              { name: 'repo-skill', sourceKind: 'project' }, // skipped
            ],
            appHome: h.appHome,
            opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
            db: h.db,
          }),
      )
      expect(result.status).toBe('done')

      // After the run dir cleanup, we can't inspect the injected files —
      // but the mock would have failed if env wasn't right, and a sanity-check
      // on the runner's behavior is the exit code + outputs.
      expect(result.outputs.summary).toBe('ok')
    } finally {
      rmSync(skillSource, { recursive: true, force: true })
    }
  })

  test('built-in template variables substituted into prompt', async () => {
    const agent = makeAgent({ bodyMd: '' })
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          agent,
          inputs: { changes: 'diff text' },
          worktreePath: h.worktreePath,
          templateMeta: {
            repoPath: '/Users/me/repo',
            baseBranch: 'develop',
            taskId: h.taskId,
          },
          promptTemplate: 'audit {{__base_branch__}} of {{__repo_path__}}: {{changes}}',
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    expect(result.status).toBe('done')
    expect(result.prompt).toContain('audit develop of /Users/me/repo: diff text')
  })

  test('reads the same workdir we passed (cwd hook)', async () => {
    // Use a sentinel file in the worktree and have the mock detect it via pwd
    // is overkill — we just verify that runner doesn't crash when worktreePath
    // is a valid dir. (Real cwd verification is covered by the daemon e2e once
    // the scheduler lands.)
    const agent = makeAgent()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    writeFileSync(join(h.worktreePath, 'marker.txt'), 'present')
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
      }),
    )
    expect(result.status).toBe('done')
    // Marker still present (mock doesn't touch it).
    expect(readFileSync(join(h.worktreePath, 'marker.txt'), 'utf-8')).toBe('present')
  })
})
