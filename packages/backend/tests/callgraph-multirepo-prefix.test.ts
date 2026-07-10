// RFC-089 P4 — supplementary coverage for multi-repo call-chain re-prefixing.
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
//
// Locks two seams that the existing structural-diff-callchain-multi-repo.test.ts
// does NOT exercise:
//
//   1. reprefixTarget's `::` (ownerClass) branch for an EXTERNAL target. The
//      existing multi-repo test only checks the `#`-ref re-prefix on a RESOLVED
//      target; an external target has NO ref (ref:undefined) so the only thing
//      that must be re-prefixed is its ownerClass via prefixSeg(label,id,'::').
//      If this branch regressed, a multi-repo sequence-diagram lifeline would
//      point at an unprefixed card and the next click would route to the wrong
//      repo. (expandService.ts:130-141, getCallTargets at :144.)
//
//   2. splitRepoRef longest-prefix tie-break when one repo's worktreeDirName is a
//      strict path-prefix of another (e.g. ['repo','repo/sub']). The existing
//      tests only use disjoint names, so the `dir.length > best.length`
//      longest-match branch (expandService.ts:119) is never actually resolved
//      against a real prefix conflict. A naive first-match impl would corrupt the
//      inner ref. (expandService.ts:113.)

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

// ---------------------------------------------------------------------------
// GAP 2: splitRepoRef longest-prefix tie-break (pure, deterministic).
// ---------------------------------------------------------------------------
describe('splitRepoRef — longest-prefix tie-break with nested dir names', () => {
  test('when one dir is a strict path-prefix of another, the longest match wins', () => {
    // Both 'repo/' and 'repo/sub/' match the ref's start; the longer one must win
    // so the inner ref is the file path inside repo/sub, not 'sub/x.ts#Y'.
    expect(splitRepoRef(['repo', 'repo/sub'], 'repo/sub/x.ts#Y')).toEqual({
      dir: 'repo/sub',
      innerRef: 'x.ts#Y',
    })
  })

  test('order-independent: only the short prefix actually matches → it wins', () => {
    // 'repo/sub/' is NOT a prefix of 'repo/x.ts#Y'; only 'repo/' matches. Reversing
    // the input order guards against any first-match dependence.
    expect(splitRepoRef(['repo/sub', 'repo'], 'repo/x.ts#Y')).toEqual({
      dir: 'repo',
      innerRef: 'x.ts#Y',
    })
  })
})

// ---------------------------------------------------------------------------
// GAP 1: getCallTargets re-prefixes an EXTERNAL target's ownerClass (`::`).
// Reuses the multi-repo git+DB harness from structural-diff-callchain-multi-repo.
// ---------------------------------------------------------------------------
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc089-ccx-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc089-ccx-repos-'))
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
    id: 'wf-ccx',
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
      workflowId: 'wf-ccx',
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

describe('getCallTargets — multi-repo external ownerClass re-prefix (RFC-089 P4)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('an external target (no ref) has its ownerClass `::` segment re-prefixed with the repo dir', async () => {
    h = await buildHarness()
    const task = await twoRepoTask(h)
    const dirA = task.repos[0]!.worktreeDirName
    const wtA = join(task.worktreePath, dirA)
    mkdirSync(join(wtA, 'src'), { recursive: true })
    // A.run() calls svc.charge(); svc is typed OrderService, BUT OrderService only
    // declares bill() → charge resolves to the class (ownerClass set) yet the
    // method is absent → resolution 'external', ref undefined.
    writeFileSync(
      join(wtA, 'src', 'A.java'),
      'class A {\n  private OrderService svc;\n  void run() {\n    svc.charge();\n  }\n}\n',
    )
    writeFileSync(
      join(wtA, 'src', 'OrderService.java'),
      'class OrderService {\n  void bill() {}\n}\n',
    )
    invalidateCallGraphIndex(wtA)

    const out = await getCallTargets(h.db, task.id, `${dirA}/src/A.java#A.run`)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'svc.charge()',
      resolution: 'external',
      // External target has no ref to re-prefix...
      ref: undefined,
      // ...but its ownerClass `::` segment IS re-prefixed with the repo dir so the
      // sequence-diagram lifeline / next click stays in repo-a.
      ownerClass: `${dirA}/src/OrderService.java::OrderService`,
    })
  })
})
