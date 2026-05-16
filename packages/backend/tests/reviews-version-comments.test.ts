// Locks in RFC-013-T2: GET /api/reviews/:nodeRunId/versions/:versionId now
// returns the doc_version's body plus the review_comments captured against
// that specific version (not the currentVersion's comments, not the union
// across all versions). The historical-version read-only view in /reviews
// depends on this slicing being correct.
//
// Coverage:
//   - Service `getDocVersionDetail` returns body + only the comments
//     belonging to the requested vid, ordered by anchor position.
//   - Returns null when versionId does not exist.
//   - Returns null when versionId exists but belongs to a different
//     reviewNodeRunId (cross-review probe guard — without this scoping the
//     endpoint would let a caller iterate doc_versions across unrelated
//     reviews by brute-forcing ULIDs).
//   - HTTP route returns the same shape and 404s consistently.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, nodeRuns, reviewComments, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { getDocVersionDetail } from '../src/services/review'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Seed {
  db: DbClient
  appHome: string
  taskId: string
  nodeRunId: string
  versions: { id: string; index: number; decision: 'pending' | 'rejected' | 'iterated' }[]
  /** comment ids per version index (1-based) */
  commentsByVersion: Record<number, string[]>
  cleanup: () => void
}

async function seed(): Promise<Seed> {
  const db = createInMemoryDb(MIGRATIONS)
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc013-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })

  const workflowId = 'wf'
  const taskId = 'task'
  const nodeRunId = 'run_rev'

  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    version: 1,
    schemaVersion: 2,
    definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [], inputs: [] }),
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/x',
    worktreePath: '/tmp/x',
    baseBranch: 'main',
    branch: 'agent-workflow/x',
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: 1,
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 2,
    status: 'awaiting_review',
  })

  // v1 rejected, v2 iterated, v3 pending. Two comments per version anchored at
  // distinct paragraphs so the asc-by-paragraphIdx order is deterministic.
  //
  // For DECIDED versions, comments come from `commentsJson` (the archived
  // snapshot — submitReviewDecision writes it and deletes the live rows).
  // For PENDING versions, comments are live `review_comments` rows. This
  // seed mirrors that production layout so the test matches reality.
  const versions: Seed['versions'] = [
    { id: 'dv_v1', index: 1, decision: 'rejected' },
    { id: 'dv_v2', index: 2, decision: 'iterated' },
    { id: 'dv_v3', index: 3, decision: 'pending' },
  ]
  const commentsByVersion: Record<number, string[]> = {}
  for (const v of versions) {
    const bodyRel = `runs/${taskId}/review/rev_1/design/v${v.index}.md`
    const bodyAbs = join(appHome, bodyRel)
    mkdirSync(dirname(bodyAbs), { recursive: true })
    writeFileSync(bodyAbs, `# v${v.index}\n\nbody`)

    // Build the comments payload first (so we know the JSON shape), then
    // insert the docVersions row, then any live review_comments rows.
    // Doing live-comment inserts before the docVersions row violates the
    // FK and crashes the seed.
    const cIds: string[] = []
    const archivedComments: Array<Record<string, unknown>> = []
    const liveComments: Array<{ id: string; k: number }> = []
    for (let k = 0; k < 2; k++) {
      const cid = `c_v${v.index}_${k}`
      cIds.push(cid)
      const anchor = {
        sectionPath: `## v${v.index} section`,
        paragraphIdx: k,
        offsetStart: 0,
        offsetEnd: 4,
        selectedText: 'body',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      }
      if (v.decision === 'pending') {
        liveComments.push({ id: cid, k })
      } else {
        archivedComments.push({
          id: cid,
          docVersionId: v.id,
          anchor,
          commentText: `c v${v.index} #${k}`,
          author: 'local',
          createdAt: 1000 + k,
        })
      }
    }
    commentsByVersion[v.index] = cIds

    await db.insert(docVersions).values({
      id: v.id,
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: nodeRunId,
      sourceNodeId: 'designer',
      sourcePortName: 'design',
      versionIndex: v.index,
      reviewIteration: v.index - 1,
      bodyPath: bodyRel,
      commentsJson: JSON.stringify(archivedComments),
      decision: v.decision,
      createdAt: v.index, // ascending so order by createdAt matches versionIndex
    })

    for (const lc of liveComments) {
      await db.insert(reviewComments).values({
        id: lc.id,
        docVersionId: v.id,
        anchorSectionPath: `## v${v.index} section`,
        anchorParagraphIdx: lc.k,
        anchorOffsetStart: 0,
        anchorOffsetEnd: 4,
        selectedText: 'body',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
        commentText: `c v${v.index} #${lc.k}`,
        author: 'local',
        createdAt: 1000 + lc.k,
      })
    }
  }

  return {
    db,
    appHome,
    taskId,
    nodeRunId,
    versions,
    commentsByVersion,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

describe('RFC-013-T2 getDocVersionDetail service', () => {
  let s: Seed
  beforeEach(async () => {
    s = await seed()
  })
  afterEach(() => s.cleanup())

  test('returns body + only the comments for the requested vid', async () => {
    const dv = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_v2')
    expect(dv).not.toBeNull()
    expect(dv!.id).toBe('dv_v2')
    expect(dv!.versionIndex).toBe(2)
    expect(dv!.decision).toBe('iterated')
    expect(dv!.body).toBe('# v2\n\nbody')
    // Only v2 comments, NOT v1 or v3 (= 6 total in the seed).
    expect(dv!.comments.length).toBe(2)
    expect(dv!.comments.map((c) => c.id).sort()).toEqual(s.commentsByVersion[2]!.sort())
  })

  test('comments come back ordered by anchor (paragraphIdx asc, then offsetStart)', async () => {
    const dv = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_v1')
    expect(dv).not.toBeNull()
    const paraIdx = dv!.comments.map((c) => c.anchor.paragraphIdx)
    expect(paraIdx).toEqual([...paraIdx].sort((a, b) => a - b))
  })

  test('returns null when versionId does not exist', async () => {
    const dv = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_does_not_exist')
    expect(dv).toBeNull()
  })

  test('returns null when versionId exists but belongs to a different nodeRunId', async () => {
    // dv_v1 belongs to s.nodeRunId; asking for it under a different runId
    // must NOT leak the row — otherwise a caller could iterate doc_versions
    // by brute-forcing the vid.
    const dv = await getDocVersionDetail(s.db, s.appHome, 'run_someone_else', 'dv_v1')
    expect(dv).toBeNull()
  })

  test('decided versions source comments from commentsJson archive, not the live table', async () => {
    // Production invariant: submitReviewDecision archives comments into
    // commentsJson and deletes the live rows. The seed mirrors that —
    // dv_v1 / dv_v2 have empty review_comments tables but populated
    // commentsJson. The endpoint must surface those archived comments
    // anyway, otherwise the historical view always shows zero comments
    // for any decided version.
    const dv1 = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_v1')
    expect(dv1).not.toBeNull()
    expect(dv1!.comments.length).toBe(2)
    expect(dv1!.comments[0]!.commentText).toBe('c v1 #0')

    // Sanity: cross-check that nothing leaks from a different version.
    expect(dv1!.comments.every((c) => c.docVersionId === 'dv_v1')).toBe(true)
  })

  test('archived commentsJson sorts by anchor.paragraphIdx asc, then offsetStart', async () => {
    // We seed in (paragraphIdx 0, then 1) order, but the JSON is opaque
    // to the storage layer; the read path must enforce the sort. Verify
    // by injecting an out-of-order JSON for an extra version.
    await s.db.insert(docVersions).values({
      id: 'dv_v_unsorted',
      taskId: s.taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: s.nodeRunId,
      sourceNodeId: 'designer',
      sourcePortName: 'design',
      versionIndex: 99,
      reviewIteration: 0,
      bodyPath: `runs/${s.taskId}/review/rev_1/design/v1.md`,
      commentsJson: JSON.stringify([
        {
          id: 'c-b',
          docVersionId: 'dv_v_unsorted',
          anchor: {
            sectionPath: 'x',
            paragraphIdx: 5,
            offsetStart: 0,
            offsetEnd: 1,
            selectedText: 'x',
            contextBefore: '',
            contextAfter: '',
            occurrenceIndex: 1,
          },
          commentText: 'late',
          author: 'local',
          createdAt: 1,
        },
        {
          id: 'c-a',
          docVersionId: 'dv_v_unsorted',
          anchor: {
            sectionPath: 'x',
            paragraphIdx: 1,
            offsetStart: 0,
            offsetEnd: 1,
            selectedText: 'x',
            contextBefore: '',
            contextAfter: '',
            occurrenceIndex: 1,
          },
          commentText: 'early',
          author: 'local',
          createdAt: 2,
        },
      ]),
      decision: 'rejected',
      createdAt: 99,
    })
    const dv = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_v_unsorted')
    expect(dv!.comments.map((c) => c.id)).toEqual(['c-a', 'c-b'])
  })

  test('corrupt commentsJson degrades to empty array (does not throw)', async () => {
    await s.db.insert(docVersions).values({
      id: 'dv_v_corrupt',
      taskId: s.taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: s.nodeRunId,
      sourceNodeId: 'designer',
      sourcePortName: 'design',
      versionIndex: 100,
      reviewIteration: 0,
      bodyPath: `runs/${s.taskId}/review/rev_1/design/v1.md`,
      commentsJson: '{not json',
      decision: 'rejected',
      createdAt: 100,
    })
    const dv = await getDocVersionDetail(s.db, s.appHome, s.nodeRunId, 'dv_v_corrupt')
    expect(dv).not.toBeNull()
    expect(dv!.comments).toEqual([])
  })
})

describe('RFC-013-T2 GET /api/reviews/:nodeRunId/versions/:versionId route', () => {
  let s: Seed
  let prevHome: string | undefined
  beforeEach(async () => {
    s = await seed()
    // Route's appHomeFor() resolves to Paths.root which honors this env var.
    prevHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = s.appHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prevHome
    if (s !== undefined) s.cleanup()
  })

  function app(): ReturnType<typeof createApp> {
    return createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: s.db,
    })
  }

  test('200 — returns body + comments scoped to vid', async () => {
    const res = await app().fetch(
      new Request(`http://localhost/api/reviews/${s.nodeRunId}/versions/dv_v2`, {
        headers: { Authorization: 'Bearer tok' },
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { body: string; comments: { id: string }[] }
    expect(json.body).toBe('# v2\n\nbody')
    expect(json.comments.length).toBe(2)
    expect(json.comments.map((c) => c.id).sort()).toEqual(s.commentsByVersion[2]!.sort())
  })

  test('404 — versionId from a different nodeRunId', async () => {
    const res = await app().fetch(
      new Request(`http://localhost/api/reviews/run_other/versions/dv_v1`, {
        headers: { Authorization: 'Bearer tok' },
      }),
    )
    expect(res.status).toBe(404)
  })

  test('404 — unknown versionId', async () => {
    const res = await app().fetch(
      new Request(`http://localhost/api/reviews/${s.nodeRunId}/versions/dv_nope`, {
        headers: { Authorization: 'Bearer tok' },
      }),
    )
    expect(res.status).toBe(404)
  })
})
