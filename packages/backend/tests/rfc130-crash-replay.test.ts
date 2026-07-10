import { rimrafDir } from './helpers/cleanup'
// RFC-130 D15 / T3c2 — crash-safety: the deriveFrontier merge_state gate + the
// resume-time pending-merge replay.
//
// Simulates a daemon crash in the segment②→③ window: the runner wrote status='done'
// but merge-back never ran (merge_state='pending-merge', delta pinned in iso_node_tree
// only). On the next runTask (resume) the replay must merge the pinned delta into the
// canonical worktree and flip merge_state='merged' — WITHOUT re-running the agent — so
// the frontier gate (which excludes non-'merged' done rows) then lets the task finish.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createNodeIso,
  discardNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '../src/services/nodeIsolation'
import { deriveFrontier, runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-crash-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@e.com'])
  await runGit(worktreePath, ['config', 'user.name', 'T'])
  writeFileSync(join(worktreePath, 'base.txt'), 'base\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}

describe('RFC-130 crash replay (D15 gate + T3c2 replay)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('deriveFrontier gate: a done row with merge_state != merged is NOT complete', () => {
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'a' },
        { id: 'B', kind: 'agent-single', agentName: 'b' },
      ],
      edges: [
        {
          id: 'eAB',
          source: { nodeId: 'A', portName: 'summary' },
          target: { nodeId: 'B', portName: 'in' },
        },
      ],
    }
    const scopeNodes = def.nodes
    const scopeIds = new Set(['A', 'B'])
    const upstreamsOf = new Map([['B', ['A']]])
    const mkRow = (mergeState: string | null) =>
      ({
        id: 'r-A',
        taskId: 't',
        nodeId: 'A',
        status: 'done',
        cause: 'initial',
        retryIndex: 0,
        iteration: 0,
        shardKey: null,
        parentNodeRunId: null,
        reviewIteration: 0,
        consumedUpstreamRunsJson: null,
        mergeState,
      }) as unknown as Parameters<typeof deriveFrontier>[0][number]

    const empty = new Set<string>()
    const front = (mergeState: string | null) =>
      deriveFrontier(
        [mkRow(mergeState)],
        def,
        scopeNodes,
        scopeIds,
        0,
        upstreamsOf,
        empty,
        empty,
        empty,
      )
    // pending-merge → A NOT complete → B not ready.
    expect(front('pending-merge').ready).not.toContain('B')
    // merged → A complete → B ready.
    expect(front('merged').ready).toContain('B')
    // legacy NULL → A complete (golden-lock) → B ready.
    expect(front(null).ready).toContain('B')
  })

  test('resume replays a pending-merge delta into canonical, then the task finishes', async () => {
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'a',
      description: '',
      outputs: JSON.stringify(['summary']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'A', kind: 'agent-single', agentName: 'a' }],
      edges: [],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(def),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      id: taskId,
      name: 'fixture',
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending', // resume: runTask CAS-claims pending → running
      inputs: '{}',
      startedAt: Date.now(),
    })

    // Fabricate the crash state: build a real iso, write the node's product into it,
    // pin the node_tree, then throw away the iso worktree (as a crash would) — only
    // the pinned shas survive on the node_run row.
    const canonRepos: CanonRepo[] = [
      {
        repoPath: h.worktreePath,
        worktreePath: h.worktreePath,
        worktreeDirName: '',
        baseBranch: 'main',
      },
    ]
    const handle = await createNodeIso({ appHome: h.appHome, taskId, nodeRunId: 'r-A', canonRepos })
    writeFileSync(join(handle.repos[0]!.isoWorktreePath, 'produced.txt'), 'by node A\n')
    const nodeTrees = await snapshotNodeIsoFinal(handle)
    await discardNodeIso(handle) // simulate the worktree being gone after a crash

    const nrId = ulid()
    await h.db.insert(nodeRuns).values({
      id: nrId,
      taskId,
      nodeId: 'A',
      status: 'done', // runner wrote done…
      startedAt: Date.now(),
      isoBaseSnapshot: handle.repos[0]!.baseSnapshot,
      isoNodeTree: nodeTrees[''],
      mergeState: 'pending-merge', // …but merge-back never ran
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: nrId, portName: 'summary', content: 'ok' })

    // canonical does NOT yet have the produced file (delta lives only in the pin).
    expect(existsSync(join(h.worktreePath, 'produced.txt'))).toBe(false)

    await runTask({ taskId, db: h.db, appHome: h.appHome })

    // Replay merged the pinned delta into canonical + flipped merge_state; task done.
    expect(readFileSync(join(h.worktreePath, 'produced.txt'), 'utf-8')).toBe('by node A\n')
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nrId)))[0]
    expect(row?.mergeState).toBe('merged')
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
  })
})
