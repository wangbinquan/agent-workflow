// RFC-072 — runNode persists the resolved output kind into node_run_outputs.kind.
//
// The runner already resolves agent.outputKinds[port] to validate file-path
// ports (envelope.ts resolvePortContent); before RFC-072 it dropped the kind on
// the floor. This locks that a `markdown_file` port lands with kind='markdown_file'
// and a port the agent declared no kind for lands with kind=null — that NULL is
// what the Outputs tab treats as "plain text, no download button".

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
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
    name: 'test-agent',
    description: 'an agent',
    outputs: ['summary'],
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-runner-kind-'))
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

describe('RFC-072 — runNode persists output kind', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('markdown_file port → kind persisted; undeclared port → kind null', async () => {
    // markdown_file ports carry a worktree-relative path in the envelope;
    // resolvePortContent validates the file exists, so create it first.
    writeFileSync(join(h.worktreePath, 'report.md'), '# Report\n')
    const agent = makeAgent({
      outputs: ['report', 'note'],
      outputKinds: { report: 'markdown_file' },
    })
    const nodeRunId = ulid()
    await h.db
      .insert(nodeRuns)
      .values({ id: nodeRunId, taskId: h.taskId, nodeId: 'n1', status: 'pending' })

    const result = await withEnv(
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ report: 'report.md', note: 'just text' }) },
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

    expect(result.status).toBe('done')

    const rows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    const report = rows.find((r) => r.portName === 'report')
    const note = rows.find((r) => r.portName === 'note')
    // File-path port: kind persisted verbatim, content is the relative path.
    expect(report?.kind).toBe('markdown_file')
    expect(report?.content).toBe('report.md')
    // Port the agent declared no kind for: kind is NULL.
    expect(note?.kind).toBeNull()
    expect(note?.content).toBe('just text')
  })
})
