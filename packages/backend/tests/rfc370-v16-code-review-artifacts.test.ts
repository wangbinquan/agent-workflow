// RFC-370 §10 V16 — the code-review artifact store (structural diffs of a
// terminal generation, the change narrative) on both deployments.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). The Changes tab of
// a finished hosted task had to wake its volume to recompute; the stored
// artifacts lived only in standalone appHome files, and those files were never
// removed with their task (the deletion chain skipped `structural-diffs/`).
// These cases lock:
//   - the standalone store keeps today's file layout and adds the terminal
//     generation, so a resumed-then-finished task is never served stale;
//   - the hosted store keys immutable publications by generation and chains
//     narratives, so a regeneration never collides with an earlier one;
//   - the hosted owner sweep releases the artifacts of deleted tasks only,
//     against real task rows on both database providers.
import { taskFixture, workflowFixture } from './helpers/model'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSummary, type ChangeNarrative, type StructuralDiff } from '@agent-workflow/shared'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/composition/codeReviewArtifacts'
import {
  composeCrewStationCodeReviewArtifacts,
  composeCrewStationCodeReviewObjectSweep,
  HOSTED_CODE_REVIEW_OWNER,
} from '@/modules/code-capability/composition/crewstationCodeReviewArtifacts'
import type { HostedCodeReviewPublications } from '@/modules/code-capability/infrastructure/crewstation/objectCodeReviewArtifacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'

let home: string
let previousHome: string | undefined
beforeAll(() => {
  previousHome = process.env.AGENT_WORKFLOW_HOME
  home = mkdtempSync(join(tmpdir(), 'aw-v16-artifacts-'))
  process.env.AGENT_WORKFLOW_HOME = home
})
afterEach(() => {
  process.env.AGENT_WORKFLOW_HOME = home
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

function diff(taskId: string, fromRef = 'base'): StructuralDiff {
  return {
    scope: 'task',
    taskId,
    fromRef,
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  }
}

function narrative(overview: string): ChangeNarrative {
  return {
    version: 1,
    overview,
    groups: [],
    readingOrder: [],
    generatedAt: 1,
    inputDigest: 'digest',
  }
}

/** In-memory publication journal with the real key immutability. */
function publications() {
  const rows = new Map<string, { scope: string | null; bytes: Uint8Array; live: boolean }>()
  const store: HostedCodeReviewPublications & { readonly rows: typeof rows } = {
    rows,
    async publish(requests) {
      return requests.map((request) => {
        const key = `${request.owner}\0${request.key}`
        const row = rows.get(key)
        if (row !== undefined) {
          if (!row.live) throw new Error('hosted-object-publication-releasing')
          if (Buffer.compare(Buffer.from(row.bytes), Buffer.from(request.bytes)) !== 0)
            throw new Error('hosted-object-publication-content-changed')
        } else rows.set(key, { scope: request.scope ?? null, bytes: request.bytes, live: true })
        return { id: key, sha256: 'x'.repeat(64), size: request.bytes.byteLength }
      })
    },
    async find(owner, key) {
      const row = rows.get(`${owner}\0${key}`)
      return row?.live === true ? { id: `${owner}\0${key}`, sha256: 'x', size: 1 } : null
    },
    async release(selection) {
      let released = 0
      for (const [key, row] of rows)
        if (key.startsWith(`${selection.owner}\0`) && row.live && row.scope === selection.scope) {
          row.live = false
          released += 1
        }
      return released
    },
    async scopes(owner) {
      return [
        ...new Set(
          [...rows]
            .filter(([key, row]) => key.startsWith(`${owner}\0`) && row.live && row.scope !== null)
            .map(([, row]) => row.scope!),
        ),
      ].sort()
    },
  }
  return store
}

function hostedStore() {
  const journal = publications()
  const store = composeCrewStationCodeReviewArtifacts({
    publications: journal,
    objects: { read: async (id) => journal.rows.get(id)!.bytes },
  })
  return { journal, store }
}

describe('RFC-370 §10 V16 standalone code-review artifacts', () => {
  test('a diff is served for its own generation; null asks for whatever is stored', async () => {
    const store = composeLocalCodeReviewArtifacts()
    const key = { taskId: 'task_v16_local', scope: 'task' as const, generation: '100' }
    await store.writeStructuralDiff(key, diff(key.taskId))
    const path = join(home, 'structural-diffs', key.taskId, 'task.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).artifactGeneration).toBe('100')
    expect(await store.readStructuralDiff(key)).toEqual(diff(key.taskId))
    expect(await store.readStructuralDiff({ ...key, generation: '200' })).toBeNull()
    expect(await store.readStructuralDiff({ ...key, generation: null })).toEqual(diff(key.taskId))
  })

  test('an artifact written before generations is still a fallback, never a generation hit', async () => {
    const store = composeLocalCodeReviewArtifacts()
    const taskId = 'task_v16_legacy'
    mkdirSync(join(home, 'structural-diffs', taskId), { recursive: true })
    writeFileSync(
      join(home, 'structural-diffs', taskId, 'node-run1.json'),
      JSON.stringify(diff(taskId)),
    )
    const key = { taskId, scope: 'node' as const, nodeRunId: 'run1' }
    expect(await store.readStructuralDiff({ ...key, generation: '5' })).toBeNull()
    expect(await store.readStructuralDiff({ ...key, generation: null })).toEqual(diff(taskId))
  })

  test('the narrative keeps its file and leaves with the task', async () => {
    const store = composeLocalCodeReviewArtifacts()
    const taskId = 'task_v16_narrative'
    expect(await store.readNarrative(taskId)).toBeNull()
    await store.writeNarrative(taskId, narrative('first'))
    await store.writeNarrative(taskId, narrative('second'))
    expect(existsSync(join(home, 'structural-diffs', taskId, 'narrative-task.json'))).toBe(true)
    expect((await store.readNarrative(taskId))?.overview).toBe('second')
    await store.removeTask(taskId)
    expect(existsSync(join(home, 'structural-diffs', taskId))).toBe(false)
  })
})

describe('RFC-370 §10 V16 hosted code-review artifacts', () => {
  test('diffs are immutable publications keyed by their terminal generation', async () => {
    const { journal, store } = hostedStore()
    const key = { taskId: 'task_v16_hosted', scope: 'task' as const, generation: '100' }
    await store.writeStructuralDiff({ ...key, generation: null }, diff(key.taskId))
    expect(journal.rows.size).toBe(0)
    await store.writeStructuralDiff(key, diff(key.taskId))
    // A second computation of the same generation is not an error.
    await store.writeStructuralDiff(key, diff(key.taskId, 'other'))
    expect([...journal.rows.keys()]).toEqual([
      `${HOSTED_CODE_REVIEW_OWNER}\0task_v16_hosted/structural/task/100`,
    ])
    expect(await store.readStructuralDiff(key)).toEqual(diff(key.taskId))
    expect(await store.readStructuralDiff({ ...key, generation: '101' })).toBeNull()
    expect(await store.readStructuralDiff({ ...key, generation: null })).toBeNull()
  })

  test('each narrative takes the next number; the latest is served; removal releases the task', async () => {
    const { journal, store } = hostedStore()
    const taskId = 'task_v16_chain'
    expect(await store.readNarrative(taskId)).toBeNull()
    await store.writeNarrative(taskId, narrative('first'))
    await store.writeNarrative(taskId, narrative('second'))
    expect((await store.readNarrative(taskId))?.overview).toBe('second')
    // A fresh process finds the same latest by probing the chain.
    const reopened = composeCrewStationCodeReviewArtifacts({
      publications: journal,
      objects: { read: async (id) => journal.rows.get(id)!.bytes },
    })
    expect((await reopened.readNarrative(taskId))?.overview).toBe('second')
    await store.removeTask(taskId)
    expect(await reopened.readNarrative(taskId)).toBeNull()
  })
})

async function seedTask(db: PersistenceDb, taskId: string): Promise<void> {
  await workflowFixture(db, {
    id: `wf-${taskId}`,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
    version: 1,
  })
  await taskFixture(db, {
    id: taskId,
    name: 't',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [] }),
    repoPath: '/repo',
    worktreePath: `cs-workspace:${taskId}/worktrees/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    baseCommit: 'base',
    // PostgreSQL 的迁移不带 SQLite 的 lineage 触发器，两侧都显式写 lineage。
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
}

describeEachProvider('RFC-370 §10 V16 hosted code-review object sweep', (harness) => {
  test('releases the publications of deleted tasks and keeps those of live ones', async () => {
    const live = `01V16LIVE${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    const deleted = `01V16GONE${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    await seedTask(harness.db, live)
    const { journal, store } = hostedStore()
    for (const taskId of [live, deleted]) {
      await store.writeStructuralDiff({ taskId, scope: 'task', generation: '1' }, diff(taskId))
      await store.writeNarrative(taskId, narrative(taskId))
    }
    const sweep = composeCrewStationCodeReviewObjectSweep({
      db: harness.db,
      publications: journal,
      graceMs: 0,
    })
    expect(sweep.name).toBe('code-review')
    expect(await sweep.sweep({ now: Date.now() })).toBe(2)
    expect(await store.readNarrative(deleted)).toBeNull()
    expect(
      await store.readStructuralDiff({ taskId: deleted, scope: 'task', generation: '1' }),
    ).toBeNull()
    expect((await store.readNarrative(live))?.overview).toBe(live)
    expect(await sweep.sweep({ now: Date.now() })).toBe(0)
  })
})
