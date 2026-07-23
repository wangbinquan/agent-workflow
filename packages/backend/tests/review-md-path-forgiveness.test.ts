// RFC-049 PR-B: integration test locking the post-forgiveness review-flow
// contract. The original incident (linked in commit history) was: upstream
// agent emitted an absolute .md path on an undeclared port → doc_versions
// body rendered the path string instead of the file contents. The PR-B
// answer is "declare outputKinds explicitly; the framework refuses to guess
// anymore." So:
//
//   * Agent declares outputKinds.<port> = markdown_file → doc_versions body
//     holds the file contents (happy path, unchanged).
//   * Agent does NOT declare outputKinds → doc_versions body holds the path
//     string verbatim. The breaking change is intentional.
//
// If this goes red, see packages/backend/src/services/envelope.ts
// (resolvePortContentDetailed) and packages/backend/src/services/review.ts
// (dispatchReviewNode upstream port resolve).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('dispatchReviewNode + RFC-049 PR-B explicit outputKinds contract', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-fp-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  async function seedFixture(opts: { declareMarkdownFileKind: boolean }) {
    const agentId = ulid()
    const frontmatter = opts.declareMarkdownFileKind
      ? JSON.stringify({ outputKinds: { design: 'markdown_file' } })
      : '{}'
    await db.insert(agentsTable).values({
      id: agentId,
      name: 'designer',
      description: '',
      outputs: JSON.stringify(['design']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: frontmatter,
      bodyMd: '',
    })

    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'designer',
          kind: 'agent-single',
          agentId,
          agentName: 'designer',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })

    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'fixture-task',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!

    mkdirSync(join(worktree, 'docs'), { recursive: true })
    const fileBody = '# Generated design\n\nbody of the file the user expects to see.'
    writeFileSync(join(worktree, 'docs', 'test_design.md'), fileBody)
    const absPath = join(worktree, 'docs', 'test_design.md')

    const designerRunId = ulid()
    await db.insert(nodeRuns).values({
      id: designerRunId,
      taskId,
      nodeId: 'designer',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerRunId,
      portName: 'design',
      content: absPath,
    })

    return { task, definition, fileBody, absPath }
  }

  test('agent declares outputKinds.<port> = markdown_file → doc_versions body holds file contents', async () => {
    const { task, definition, fileBody, absPath } = await seedFixture({
      declareMarkdownFileKind: true,
    })
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    const result = await dispatchReviewNode({
      db,
      taskId: task.id,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')

    const dvs = await db.select().from(docVersions)
    expect(dvs.length).toBe(1)
    const onDisk = readFileSync(join(appHome, dvs[0]!.bodyPath), 'utf8')
    expect(onDisk).toBe(fileBody)
    expect(onDisk).not.toContain(absPath)
  })

  test('agent omits outputKinds → doc_versions body holds the raw path string (PR-B breaking change)', async () => {
    const { task, definition, fileBody, absPath } = await seedFixture({
      declareMarkdownFileKind: false,
    })
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    const result = await dispatchReviewNode({
      db,
      taskId: task.id,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')

    const dvs = await db.select().from(docVersions)
    expect(dvs.length).toBe(1)
    const onDisk = readFileSync(join(appHome, dvs[0]!.bodyPath), 'utf8')
    // After PR-B the body is whatever the upstream port emitted — the path
    // string here, NOT the file contents at that path.
    expect(onDisk).toBe(absPath)
    expect(onDisk).not.toContain(fileBody)
  })
})
