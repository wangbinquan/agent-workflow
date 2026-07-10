// RFC-089 P4 — call-chain expansion for multi-repo tasks. In a multi-repo diff
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
// the graph's refs are `${worktreeDirName}/${filePath}#${qn}` (mergeStructuralDiffs
// prefixes them). getCallTargets must route such a ref to THAT repo's worktree,
// expand against the UN-prefixed ref, and re-prefix the returned targets so the
// chain keeps resolving in the same repo on the next click. Also locks the pure
// splitRepoRef seam.

import { afterEach, describe, expect, test } from 'bun:test'
import type { StartTask } from '@agent-workflow/shared'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  getCallTargets,
  splitRepoRef,
  invalidateCallGraphIndex,
} from '../src/services/structuralDiff/callGraph/expandService'
import { startTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

describe('splitRepoRef', () => {
  test('strips the matching repo-dir prefix', () => {
    expect(splitRepoRef(['repo-a', 'repo-b'], 'repo-b/pkg/m.go#S.f')).toEqual({
      dir: 'repo-b',
      innerRef: 'pkg/m.go#S.f',
    })
  })
  test('no matching repo prefix → dir null, ref unchanged', () => {
    expect(splitRepoRef(['repo-a', 'repo-b'], 'src/x.ts#Y')).toEqual({
      dir: null,
      innerRef: 'src/x.ts#Y',
    })
  })
  test('a bare dir name without a trailing slash does not match', () => {
    expect(splitRepoRef(['repo-a'], 'repo-a')).toEqual({ dir: null, innerRef: 'repo-a' })
  })
  test('empty dir names are skipped (no false match)', () => {
    expect(splitRepoRef([''], 'foo/x#Y')).toEqual({ dir: null, innerRef: 'foo/x#Y' })
  })
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc089-cc-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc089-cc-repos-'))
  const repos: string[] = []
  for (let i = 0; i < 2; i++) {
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
    id: 'wf-cc',
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
      rmSync(appHome, { recursive: true, force: true })
      rmSync(reposParent, { recursive: true, force: true })
    },
  }
}

async function twoRepoTask(h: Harness) {
  return startTask(
    {
      workflowId: 'wf-cc',
      name: 't',
      repos: [
        { repoPath: h.repos[0]!, baseBranch: 'main' },
        { repoPath: h.repos[1]!, baseBranch: 'main' },
      ],
      inputs: {},
    } as unknown as StartTask,
    { db: h.db, appHome: h.appHome },
  )
}

describe('getCallTargets — multi-repo (RFC-089 P4)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('routes a repo-prefixed ref to that repo and re-prefixes the resolved target', async () => {
    h = await buildHarness()
    const task = await twoRepoTask(h)
    const dirA = task.repos[0]!.worktreeDirName
    const wtA = join(task.worktreePath, dirA)
    mkdirSync(join(wtA, 'src'), { recursive: true })
    writeFileSync(
      join(wtA, 'src', 'A.java'),
      'class A {\n  private OrderService svc;\n  void run() {\n    svc.charge();\n  }\n}\n',
    )
    writeFileSync(
      join(wtA, 'src', 'OrderService.java'),
      'class OrderService {\n  void charge() {}\n}\n',
    )
    invalidateCallGraphIndex(wtA)

    const out = await getCallTargets(h.db, task.id, `${dirA}/src/A.java#A.run`)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'charge()',
      resolution: 'resolved',
      // Resolved within repo-a's worktree, then re-prefixed with the repo dir so
      // the next expand stays in repo-a.
      ref: `${dirA}/src/OrderService.java#OrderService.charge`,
    })
  })

  test('a ref with no matching repo prefix → call-target-repo-unresolved', async () => {
    h = await buildHarness()
    const task = await twoRepoTask(h)
    await expect(getCallTargets(h.db, task.id, 'nope/src/A.java#A.run')).rejects.toThrow(
      /does not match any repo/,
    )
  })
})
