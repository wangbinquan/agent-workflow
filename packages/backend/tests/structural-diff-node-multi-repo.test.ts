import { rimrafDir } from './helpers/cleanup'
// RFC-089 P3 — getTaskStructuralDiff node scope must work for multi-repo tasks.
// It threw `structural-node-scope-multi-repo-unsupported` before; it now resolves
// + computes per repo (reusing resolveNodeScope over each repo's
// `pre_snapshot_repos_json` column via perRepoNodeRuns) and merges. This locks:
//   (1) the unsupported throw is GONE,
//   (2) the multi-repo branch runs and degrades gracefully when a snapshot isn't
//       resolvable (instead of 500-ing),
//   (3) an unknown nodeRunId is a clean 404, not the old blanket throw.
// The happy-path per-repo resolution + prefixed merge are unit-covered in
// structural-diff-refselect.test.ts and structural-diff-multi-repo-merge.test.ts.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { getTaskStructuralDiff } from '../src/services/structuralDiff/service'
import { startTask } from '../src/services/task'
import { nodeRuns, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc089-node-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc089-node-repos-'))
  const repos: string[] = []
  for (let i = 0; i < repoCount; i++) {
    const repoPath = mkdtempSync(join(reposParent, `r${i}-`))
    await runGit(repoPath, ['init', '-q', '-b', 'main'])
    await runGit(repoPath, ['config', 'user.email', 't@t'])
    await runGit(repoPath, ['config', 'user.name', 'T'])
    writeFileSync(join(repoPath, 'README.md'), `# repo-${i}\n`)
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    repos.push(repoPath)
  }
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({
    id: 'wf-node',
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return {
    db,
    appHome,
    repos,
    cleanup: () => {
      rimrafDir(appHome)
      rimrafDir(reposParent)
    },
  }
}

async function twoRepoTask(h: Harness) {
  return startTask(
    {
      workflowId: 'wf-node',
      name: 't',
      repos: [
        { repoPath: h.repos[0]!, baseBranch: 'main' },
        { repoPath: h.repos[1]!, baseBranch: 'main' },
      ],
      inputs: {},
    },
    { db: h.db, appHome: h.appHome },
  )
}

describe('RFC-089 P3 — structural node scope, multi-repo', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('per-repo branch runs (no `unsupported` throw) and degrades gracefully', async () => {
    h = await buildHarness(2)
    const task = await twoRepoTask(h)
    expect(task.repos.length).toBe(2)
    // A node_run with a per-repo snapshot map. The shas are not real git objects,
    // so per-repo compute fails → caught → graceful 'pruned'. The POINT is the
    // multi-repo branch runs at all instead of throwing unsupported.
    const nrId = 'nr-multi'
    await h.db.insert(nodeRuns).values({
      id: nrId,
      taskId: task.id,
      nodeId: 'n1',
      status: 'done',
      startedAt: Date.now(),
      preSnapshotReposJson: JSON.stringify({
        [task.repos[0]!.worktreeDirName]: 'deadbeef'.repeat(5),
        [task.repos[1]!.worktreeDirName]: 'deadbeef'.repeat(5),
      }),
    })

    const diff = await getTaskStructuralDiff(h.db, task.id, 'node', nrId)
    expect(diff.scope).toBe('node')
    expect(diff.nodeRunId).toBe(nrId)
    // All repos' snapshots unresolvable → pruned (graceful), not a 500/throw.
    expect(diff.status).toBe('pruned')
    expect(diff.degradedReason).toBe('snapshot-pruned')
  })

  test('a node that wrote no repo (no snapshot map) → readonly, not unsupported', async () => {
    h = await buildHarness(2)
    const task = await twoRepoTask(h)
    const nrId = 'nr-readonly'
    await h.db.insert(nodeRuns).values({
      id: nrId,
      taskId: task.id,
      nodeId: 'n1',
      status: 'done',
      startedAt: Date.now(),
      // no preSnapshotReposJson → the node wrote nothing → readonly per repo.
    })
    const diff = await getTaskStructuralDiff(h.db, task.id, 'node', nrId)
    expect(diff.scope).toBe('node')
    expect(diff.degradedReason).toBe('readonly-node-no-snapshot')
  })

  test('unknown nodeRunId in a multi-repo task → node-run-not-found (not unsupported)', async () => {
    h = await buildHarness(2)
    const task = await twoRepoTask(h)
    await expect(getTaskStructuralDiff(h.db, task.id, 'node', 'does-not-exist')).rejects.toThrow(
      /not found/,
    )
  })
})
