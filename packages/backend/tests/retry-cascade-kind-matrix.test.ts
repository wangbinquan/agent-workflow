import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1d — retry-cascade kind matrix.
//
// For every NodeKind, verify retryNode's cascade behavior when that kind is
// DOWNSTREAM of the user-clicked target:
//   - agent-single / wrapper-git / wrapper-loop / wrapper-fanout → mint placeholder
//     (RFC-060 PR-E: agent-multi removed)
//   - review / clarify / output / input                       → SKIP
//
// The user-clicked target (`runRow.nodeId`) is minted regardless of kind,
// with ONE carve-out (RFC-098 B3, audit ⑥-11): a WRAPPER's own
// canceled/interrupted row is a revival signal — minting a failed placeholder
// over it would shadow the resumable row and restart the wrapper from
// iteration 0 instead of continuing (rfc095-wrapper-canceled-revival locks
// the end-to-end continue semantics; the TARGET tests below pin the mint
// matrix including the carve-out).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { runGit } from '../src/util/git'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DOWNSTREAM_KINDS_MINT = [
  'agent-single',
  'wrapper-git',
  'wrapper-loop',
  'wrapper-fanout',
] as const satisfies readonly NodeKind[]

const DOWNSTREAM_KINDS_SKIP = [
  'review',
  'clarify',
  'clarify-cross-agent',
  'output',
  'input',
] as const satisfies readonly NodeKind[]

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1d-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    cleanup: () => rimrafDir(tmp),
  }
}

async function seedTaskWithEdge(
  h: Harness,
  downstreamNodeId: string,
  downstreamKind: NodeKind,
): Promise<{ taskId: string; agentRunId: string }> {
  // Build a minimal 2-node definition: agent_a → downstream.
  // Downstream node config minimally satisfies the kind:
  const downstreamNode = ((): Record<string, unknown> => {
    switch (downstreamKind) {
      case 'agent-single':
        return { id: downstreamNodeId, kind: 'agent-single', agentName: 'x', promptTemplate: '' }
      // RFC-060 PR-E: 'agent-multi' was removed; fan-out is wrapper-fanout now.
      case 'wrapper-git':
        return { id: downstreamNodeId, kind: 'wrapper-git', nodeIds: [] }
      case 'wrapper-loop':
        return {
          id: downstreamNodeId,
          kind: 'wrapper-loop',
          nodeIds: [],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty', portRef: { nodeId: 'x', portName: 'y' } },
        }
      case 'review':
        return {
          id: downstreamNodeId,
          kind: 'review',
          inputSource: { nodeId: 'agent_a', portName: 'out' },
        }
      case 'clarify':
        return { id: downstreamNodeId, kind: 'clarify' }
      case 'clarify-cross-agent':
        // RFC-056 — cross-clarify shares the non-process retry-cascade
        // behaviour with RFC-023 clarify (skip placeholder mint). Wiring the
        // 1-in / 2-out node here just exercises the dispatch path; the
        // upstream agent's retry never spawns a placeholder on it.
        return { id: downstreamNodeId, kind: 'clarify-cross-agent' }
      case 'wrapper-fanout':
        // RFC-060 — fanout wrapper shares the wrapper-* retry-cascade row
        // (mint placeholder on upstream retry). The minimal viable shape
        // here is enough to drive the matrix; PR-D's scheduler tests cover
        // the actual fan-out dispatch.
        return {
          id: downstreamNodeId,
          kind: 'wrapper-fanout',
          nodeIds: [],
          inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
        }
      case 'output':
        return { id: downstreamNodeId, kind: 'output' }
      case 'input':
        return { id: downstreamNodeId, kind: 'input', inputKey: 'topic' }
      default: {
        const _exhaustive: never = downstreamKind
        throw new Error(`unexpected kind ${_exhaustive as string}`)
      }
    }
  })()

  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'agent_a', kind: 'agent-single', agentName: 'doc', promptTemplate: '' },
      downstreamNode,
    ] as never,
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'agent_a', portName: 'out' },
        target: { nodeId: downstreamNodeId, portName: 'in' },
      },
    ],
  }
  const workflowId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'failed',
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    errorSummary: 'boom',
  })
  const agentRunId = ulid()
  await h.db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: 'agent_a',
    status: 'failed',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 200,
    finishedAt: Date.now() - 100,
  })
  // Seed a previous row on the downstream node so existing.retryIndex
  // computation has a baseline (otherwise placeholders start at 0 — also
  // valid, but seeding makes intent explicit).
  await h.db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: downstreamNodeId,
    status:
      downstreamKind === 'review'
        ? 'awaiting_review'
        : downstreamKind === 'clarify'
          ? 'done'
          : downstreamKind === 'output'
            ? 'done'
            : downstreamKind === 'input'
              ? 'done'
              : 'done',
    retryIndex: 0,
    reviewIteration: 0,
    iteration: 0,
    startedAt: Date.now() - 90,
    finishedAt: downstreamKind === 'review' ? null : Date.now() - 80,
  })
  return { taskId, agentRunId }
}

describe('RFC-053 PR-A T1d — retry cascade kind matrix', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  for (const kind of DOWNSTREAM_KINDS_MINT) {
    test(`MINT — downstream kind '${kind}' gets placeholder row at retryIndex+1`, async () => {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, kind)

      await retryNode(h.db, taskId, agentRunId, {
        cascade: true,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const placeholders = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.errorMessage === 'queued for retry')
      const onDownstream = placeholders.find((r) => r.nodeId === downId)
      expect(onDownstream).toBeDefined()
      expect(onDownstream!.retryIndex).toBe(1)
      expect(onDownstream!.status).toBe('failed')
    })
  }

  for (const kind of DOWNSTREAM_KINDS_SKIP) {
    test(`SKIP — downstream kind '${kind}' is NOT minted (RFC-052)`, async () => {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, kind)

      await retryNode(h.db, taskId, agentRunId, {
        cascade: true,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const placeholders = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.errorMessage === 'queued for retry')
      expect(placeholders.find((r) => r.nodeId === downId)).toBeUndefined()
    })
  }

  test('TARGET — even non-process target gets minted (current behavior, may change in PR-C)', async () => {
    // The user-clicked target is unconditionally added to `targets` in
    // retryNode (current behavior). If the user picks a review row directly,
    // a placeholder is minted for it. This is awkward semantically (you
    // can't "retry" a human decision) but is the current state.
    const downId = 'rev_x'
    const { taskId } = await seedTaskWithEdge(h, downId, 'review')

    // Find the seeded review row and "retry" it.
    const reviewRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, downId)))[0]!

    await retryNode(h.db, taskId, reviewRow.id, {
      cascade: false,
      deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
    })

    const all = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const reviewRows = all.filter((r) => r.nodeId === downId)
    expect(reviewRows.length).toBe(2) // original + placeholder retry=1
    const placeholder = reviewRows.find((r) => r.retryIndex === 1)
    expect(placeholder).toBeDefined()
    expect(placeholder!.errorMessage).toBe('queued for retry')
  })

  // RFC-098 B3 (audit ⑥-11) — the wrapper-revival carve-out on the TARGET row.
  for (const status of ['canceled', 'interrupted'] as const) {
    test(`TARGET — wrapper '${status}' row gets NO placeholder (revival signal, ⑥-11)`, async () => {
      const downId = 'down_wrapper_loop'
      const { taskId } = await seedTaskWithEdge(h, downId, 'wrapper-loop')
      // Re-stamp the seeded wrapper row into the revival status and target it.
      const wrapRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, downId)))[0]!
      // rfc053-allow-direct-status-write -- test seeding, not a production transition
      await h.db.update(nodeRuns).set({ status }).where(eq(nodeRuns.id, wrapRow.id))

      await retryNode(h.db, taskId, wrapRow.id, {
        cascade: true,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const all = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      const wrapRows = all.filter((r) => r.nodeId === downId)
      // No placeholder: the canceled/interrupted row stays the node's latest
      // (isDispatchable revival + findResumableWrapperRun same-row resume).
      expect(wrapRows.length).toBe(1)
      expect(wrapRows[0]!.id).toBe(wrapRow.id)
      expect(all.filter((r) => r.errorMessage === 'queued for retry')).toHaveLength(0)
    })
  }

  test('TARGET — wrapper done/failed rows still get the placeholder (terminal for findResumableWrapperRun)', async () => {
    for (const status of ['done', 'failed'] as const) {
      const downId = 'down_wrapper_loop'
      const { taskId } = await seedTaskWithEdge(h, downId, 'wrapper-loop')
      const wrapRow = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.nodeId === downId)[0]!
      // rfc053-allow-direct-status-write -- test seeding, not a production transition
      await h.db.update(nodeRuns).set({ status }).where(eq(nodeRuns.id, wrapRow.id))

      await retryNode(h.db, taskId, wrapRow.id, {
        cascade: false,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const wrapRows = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.nodeId === downId)
      expect(wrapRows.length).toBe(2) // original + placeholder
      const placeholder = wrapRows.find((r) => r.retryIndex === 1)
      expect(placeholder?.errorMessage).toBe('queued for retry')
    }
  })
})
