import { rimrafDir } from './helpers/cleanup'
// RFC-052 regression: `retryNode` must NOT mint `retryIndex+1` placeholder
// rows (status=failed, errorMessage='queued for retry') for downstream
// non-process kinds: review, clarify, output, input. Those kinds don't have
// a per-attempt process state — their runOneNode paths are no-ops or driven
// by external events — so the placeholder rows confused `isFresherNodeRun`
// in dispatchReviewNode and reset approved review rows back to awaiting_review.
//
// Locks the upstream half of the fix for production task 01KS1N8WVZWE8FTR4K9WSETRNW.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('retryNode cascade skips non-process kinds (RFC-052)', () => {
  let db: DbClient
  let appHome: string
  let repoPath: string

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc052-retry-'))
    repoPath = mkdtempSync(join(tmpdir(), 'aw-rfc052-retry-repo-'))
    await runGit(repoPath, ['init', '-q', '-b', 'main'])
    await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
    await runGit(repoPath, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoPath, 'README.md'), '# repo\n')
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rimrafDir(appHome)
    rimrafDir(repoPath)
  })

  test('retry on agent does NOT mint placeholders for downstream review/clarify/output', async () => {
    // Topology: input → agent → clarify → review → output.
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' } as never,
        { id: 'agent_1', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as never,
        { id: 'clarify_1', kind: 'clarify' } as never,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'agent_1', portName: 'docpath' },
        } as never,
        { id: 'out_1', kind: 'output' } as never,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agent_1', portName: 'docpath' },
          target: { nodeId: 'clarify_1', portName: 'in' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clarify_1', portName: 'out' },
          target: { nodeId: 'rev_1', portName: 'in' },
        },
        {
          id: 'e4',
          source: { nodeId: 'rev_1', portName: 'approved_doc' },
          target: { nodeId: 'out_1', portName: 'doc' },
        },
      ],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      definition: JSON.stringify(definition),
    })

    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'rfc-052-retry',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath,
      worktreePath: repoPath,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      errorSummary: 'boom',
    })

    // Latest agent run: done, what the user clicks "Retry" on.
    const agentRunId = ulid()
    await db.insert(nodeRuns).values({
      id: agentRunId,
      taskId,
      nodeId: 'agent_1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
    })
    // Pre-existing rows for downstream nodes (will be in `downstream` set).
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'clarify_1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 90,
      finishedAt: Date.now() - 80,
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now() - 70,
    })
    // (Output node intentionally has no node_run row pre-existing — retryNode
    // should still skip it because of the kind filter, not because there's
    // nothing to inherit from.)

    await retryNode(db, taskId, agentRunId, {
      cascade: true,
      deps: { db, appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
    })

    // The fresh placeholder must exist for agent_1 (retryIndex=1, failed),
    // but NOT for clarify_1 / rev_1 / out_1.
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const placeholders = rows.filter((r) => r.errorMessage === 'queued for retry')
    const placeholderNodes = new Set(placeholders.map((r) => r.nodeId))

    expect(placeholderNodes.has('agent_1')).toBe(true)
    expect(placeholderNodes.has('clarify_1')).toBe(false)
    expect(placeholderNodes.has('rev_1')).toBe(false)
    expect(placeholderNodes.has('out_1')).toBe(false)

    // And the one fresh row is at retryIndex=1.
    const agentPlaceholder = placeholders.find((r) => r.nodeId === 'agent_1')!
    expect(agentPlaceholder.retryIndex).toBe(1)
    expect(agentPlaceholder.status).toBe('failed')
  })

  test('retry without cascade still works (no downstream rows minted)', async () => {
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'agent_a', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as never,
        { id: 'agent_b', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as never,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'agent_a', portName: 'out' },
          target: { nodeId: 'agent_b', portName: 'in' },
        },
      ],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      definition: JSON.stringify(definition),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'rfc-052-nocascade',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath,
      worktreePath: repoPath,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    const aRunId = ulid()
    await db.insert(nodeRuns).values({
      id: aRunId,
      taskId,
      nodeId: 'agent_a',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
    })

    await retryNode(db, taskId, aRunId, {
      cascade: false,
      deps: { db, appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
    })

    const placeholders = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.errorMessage === 'queued for retry')
    expect(placeholders.length).toBe(1)
    expect(placeholders[0]!.nodeId).toBe('agent_a')
  })
})
