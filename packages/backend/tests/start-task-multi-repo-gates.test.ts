import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-066 PR-A T6 — multi-repo + wrapper-git / upload gates.
//
// Cases covered:
//   B13 workflow with a wrapper-git node + repos.length > 1 → 422 with code
//       `multi-repo-wrapper-git-unsupported` and the offending nodeId(s) in
//       the detail.
//   B14 workflow with an upload input + repos.length > 1 → 422 with code
//       `multi-repo-upload-unsupported` and the offending input keys in
//       the detail.
//   B15 single-repo (length === 1) + wrapper-git → still launches normally
//       (v1 only blocks the multi-repo combo).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { startTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-gates-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-gates-repos-'))
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

async function seedWorkflow(db: DbClient, def: unknown): Promise<string> {
  const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await db.insert(workflows).values({
    id,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

describe('RFC-066 PR-A T6 — multi-repo gates', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('B13 multi-repo + wrapper-git workflow → 422 multi-repo-wrapper-git-unsupported', async () => {
    h = await buildHarness(2)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'wg-1', kind: 'wrapper-git', nodeIds: ['x'] }],
      edges: [],
    })
    let err: unknown = null
    try {
      await startTask(
        {
          workflowId: wfId,
          name: 't',
          repos: [
            { repoPath: h.repos[0]!, baseBranch: 'main' },
            { repoPath: h.repos[1]!, baseBranch: 'main' },
          ],
          inputs: {},
        },
        { db: h.db, appHome: h.appHome },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe('multi-repo-wrapper-git-unsupported')
    const details = (err as ValidationError).details as { wrapperGitNodes: string[] }
    expect(details.wrapperGitNodes).toContain('wg-1')
  })

  test('B14 multi-repo + upload input → 422 multi-repo-upload-unsupported', async () => {
    h = await buildHarness(2)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      inputs: [{ key: 'attachments', label: 'Files', kind: 'upload' }],
      nodes: [],
      edges: [],
    })
    let err: unknown = null
    try {
      await startTask(
        {
          workflowId: wfId,
          name: 't',
          repos: [
            { repoPath: h.repos[0]!, baseBranch: 'main' },
            { repoPath: h.repos[1]!, baseBranch: 'main' },
          ],
          inputs: {},
        },
        { db: h.db, appHome: h.appHome },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe('multi-repo-upload-unsupported')
    const details = (err as ValidationError).details as { uploadInputs: string[] }
    expect(details.uploadInputs).toContain('attachments')
  })

  test('B15 single-repo + wrapper-git → still launches (gate only fires when multi-repo)', async () => {
    h = await buildHarness(1)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'wg-1', kind: 'wrapper-git', nodeIds: ['x'] }],
      edges: [],
    })
    const task = await startTask(
      {
        workflowId: wfId,
        name: 't',
        repoPath: h.repos[0]!,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Single-repo path keeps RFC-040 / wrapper-git behavior — no 422.
    // Task may or may not run to completion (scheduler is async and may emit
    // its own errors for an empty-inner wrapper-git), but startTask itself
    // does not throw.
    expect(task.id).toBeDefined()
    expect(task.repoCount).toBe(1)
  })
})
