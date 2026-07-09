import { rimrafDir } from './helpers/cleanup'
// RFC-101 PR-B — fusion engine.
//
// Validates the parts that don't need a live opencode: the fusion state
// machine, createFusion's ACL/precondition rejections, and the
// launch → reconcile → approve happy path (the engine task is launched for
// real — proving the built-in aw-skill-fusion workflow + aw-skill-merger agent
// seed and pass launch-time validation — then the agent's worktree edits +
// result manifest are simulated and the task forced terminal, exercising the
// real diff/manifest/incorporated⊆selected reconcile + the atomic apply
// (skill version bump + memory fuse) + OCC).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join as pjoin } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { isWindows, stubCmd } from './helpers/stub-runtime'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, tasks } from '../src/db/schema'
import {
  approveFusion,
  createFusion,
  getFusion,
  isValidFusionTransition,
  reconcileFusion,
  type FusionDeps,
} from '../src/services/fusion'
import { getTask } from '../src/services/task'
import { createManagedSkill, importExternalSkill, type SkillFsOptions } from '../src/services/skill'
import { getSkillVersionContent } from '../src/services/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Use the migration-seeded '__system__' admin user so task-membership inserts
// (which FK to users.id) succeed.
const adminActor: Actor = {
  user: {
    id: '__system__',
    username: '__system__',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
  permissions: new Set(),
}

/** Stub opencode that always asks one clarify question (parks the task). */
function makeClarifyStub(dir: string): string {
  const env =
    '<workflow-clarify>{\\"questions\\":[{\\"id\\":\\"q1\\",\\"title\\":\\"Proceed?\\",\\"kind\\":\\"single\\",\\"options\\":[{\\"label\\":\\"yes\\"},{\\"label\\":\\"no\\"}]}]}</workflow-clarify>'

  if (isWindows) {
    const path = pjoin(dir, 'stub-opencode.js')
    const js = `// Auto-generated stub opencode for Windows test compatibility
const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(${JSON.stringify('stub-opencode 1.14.99\n')})
  process.exit(0)
}
if (args[0] === 'run') {
  const env = ${JSON.stringify(env)}
  process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: env } }) + '\\n')
  process.exit(0)
}
process.exit(1)
`
    writeFileSync(path, js)
    return path
  }

  const path = pjoin(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  TS=$(date +%s%3N)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "${env}"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

interface H {
  db: DbClient
  appHome: string
  deps: FusionDeps
  cleanup: () => void
}
function build(): H {
  const tmp = mkdtempSync(pjoin(tmpdir(), 'aw-fusion-'))
  const appHome = pjoin(tmp, 'home')
  const db = createInMemoryDb(MIGRATIONS)
  const deps: FusionDeps = {
    db,
    appHome,
    opencodeCmd: stubCmd(makeClarifyStub(tmp)),
    awaitScheduler: true,
  }
  return { db, appHome, deps, cleanup: () => rimrafDir(tmp) }
}

function approvedGlobalMemory(db: DbClient, title: string): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: 'global',
      scopeId: null,
      title,
      bodyMd: `body of ${title}`,
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      createdAt: Date.now(),
      version: 1,
    })
    .run()
  return id
}

function statusOf(db: DbClient, id: string): string {
  return (
    db.select().from(memories).where(eq(memories.id, id)).all() as Array<{ status: string }>
  )[0]!.status
}

describe('isValidFusionTransition', () => {
  test('legal transitions', () => {
    expect(isValidFusionTransition('running', 'awaiting_approval')).toBe(true)
    expect(isValidFusionTransition('awaiting_approval', 'applying')).toBe(true)
    expect(isValidFusionTransition('awaiting_approval', 'running')).toBe(true) // reject re-run
    expect(isValidFusionTransition('applying', 'done')).toBe(true)
  })
  test('illegal transitions', () => {
    expect(isValidFusionTransition('done', 'running')).toBe(false)
    expect(isValidFusionTransition('running', 'done')).toBe(false) // must pass awaiting_approval
    expect(isValidFusionTransition('canceled', 'running')).toBe(false)
  })
})

describe('createFusion preconditions', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('rejects an external (non-managed) skill', async () => {
    const ext = mkdtempSync(pjoin(tmpdir(), 'aw-ext-'))
    writeFileSync(pjoin(ext, 'SKILL.md'), '---\nname: ext\ndescription: d\n---\nbody')
    await importExternalSkill(h.db, { name: 'ext', externalPath: ext, description: 'd' })
    const mem = approvedGlobalMemory(h.db, 'm')
    let code: string | undefined
    try {
      await createFusion({ skillName: 'ext', memoryIds: [mem], intent: '' }, h.deps, adminActor)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('fusion-skill-not-managed')
    rimrafDir(ext)
  })

  test('rejects a non-approved memory', async () => {
    await createManagedSkill(h.db, { appHome: h.appHome } as SkillFsOptions, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    h.db.update(memories).set({ status: 'archived' }).where(eq(memories.id, mem)).run()
    let code: string | undefined
    try {
      await createFusion({ skillName: 'lint', memoryIds: [mem], intent: '' }, h.deps, adminActor)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('fusion-memory-not-approved')
  })
})

describe('launch → reconcile → approve', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('full happy path: skill bumps + incorporated memory fused', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'original body',
      frontmatterExtra: {},
    })
    const memA = approvedGlobalMemory(h.db, 'use-2-spaces')
    const memB = approvedGlobalMemory(h.db, 'redundant')

    // Launch — proves the built-in workflow + agent seed & pass validation.
    // The stub clarifies, so the engine task parks and createFusion returns
    // with the fusion 'running'.
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [memA, memB], intent: 'tidy up' },
      h.deps,
      adminActor,
    )
    expect(fusion.status).toBe('running')
    expect(fusion.currentTaskId).not.toBeNull()

    // Simulate the agent's final round: edit the skill files + write the result
    // manifest into the engine worktree, then force the task terminal.
    const task = await getTask(h.db, fusion.currentTaskId!)
    const wt = task!.worktreePath
    writeFileSync(
      pjoin(wt, 'SKILL.md'),
      '---\nname: lint\ndescription: d\n---\nfused body (2 spaces)',
    )
    mkdirSync(pjoin(wt, '__fusion__'), { recursive: true })
    writeFileSync(
      pjoin(wt, '__fusion__', 'result.json'),
      JSON.stringify({
        incorporatedMemoryIds: [memA],
        skipped: [{ memoryId: memB, reason: 'redundant with existing content' }],
        changelog: 'Integrated 2-space rule.',
      }),
    )
    h.db
      .update(tasks)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(tasks.id, task!.id))
      .run()

    // Reconcile → awaiting_approval with the proposed diff + incorporated set.
    await reconcileFusion(h.deps, fusion.id)
    const ready = await getFusion(h.deps, fusion.id)
    expect(ready!.status).toBe('awaiting_approval')
    expect(ready!.incorporatedMemoryIds).toEqual([memA])
    expect(ready!.skipped?.[0]?.memoryId).toBe(memB)
    expect(ready!.proposedDiff).toContain('diff --git a/SKILL.md b/SKILL.md')
    expect(ready!.proposedDiff).toContain('fused body')
    expect(ready!.proposedDiff).not.toContain('__fusion__') // scaffold excluded

    // Approve → skill v2 + memA fused (provenance), memB still approved.
    const done = await approveFusion(h.deps, fusion.id, adminActor)
    expect(done.status).toBe('done')
    expect(done.appliedSkillVersion).toBe(2)
    expect(getSkillVersionContent(h.db, fsOpts, 'lint', 2).content.bodyMd).toContain('fused body')
    expect(statusOf(h.db, memA)).toBe('fused')
    expect(statusOf(h.db, memB)).toBe('approved')
    // live SKILL.md updated
    expect(
      readFileSync(pjoin(h.appHome, 'skills', 'lint', 'files', 'SKILL.md'), 'utf-8'),
    ).toContain('fused body')
  })

  test('OCC: approve fails if the skill changed since the fusion started', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'original',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [mem], intent: '' },
      h.deps,
      adminActor,
    )
    const task = await getTask(h.db, fusion.currentTaskId!)
    const wt = task!.worktreePath
    writeFileSync(pjoin(wt, 'SKILL.md'), '---\nname: lint\ndescription: d\n---\nproposed')
    mkdirSync(pjoin(wt, '__fusion__'), { recursive: true })
    writeFileSync(
      pjoin(wt, '__fusion__', 'result.json'),
      JSON.stringify({ incorporatedMemoryIds: [mem], skipped: [], changelog: 'x' }),
    )
    h.db
      .update(tasks)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(tasks.id, task!.id))
      .run()
    await reconcileFusion(h.deps, fusion.id)

    // A concurrent editor save bumps the skill (base was 1, now 2).
    const { writeSkillContent } = await import('../src/services/skill')
    await writeSkillContent(h.db, fsOpts, 'lint', { bodyMd: 'edited elsewhere' }, 'someone')

    await expect(approveFusion(h.deps, fusion.id, adminActor)).rejects.toThrow()
    const failed = await getFusion(h.deps, fusion.id)
    expect(failed!.status).toBe('failed')
    expect(statusOf(h.db, mem)).toBe('approved') // not fused — apply rolled back
  })

  test('reconcile fails when the manifest omits a selected memory (Codex P2 #5)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const memA = approvedGlobalMemory(h.db, 'a')
    const memB = approvedGlobalMemory(h.db, 'b')
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [memA, memB], intent: '' },
      h.deps,
      adminActor,
    )
    const task = await getTask(h.db, fusion.currentTaskId!)
    const wt = task!.worktreePath
    writeFileSync(pjoin(wt, 'SKILL.md'), '---\nname: lint\ndescription: d\n---\nproposed')
    mkdirSync(pjoin(wt, '__fusion__'), { recursive: true })
    // memB is in NEITHER incorporated nor skipped → contract violation.
    writeFileSync(
      pjoin(wt, '__fusion__', 'result.json'),
      JSON.stringify({ incorporatedMemoryIds: [memA], skipped: [], changelog: 'x' }),
    )
    h.db
      .update(tasks)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(tasks.id, task!.id))
      .run()
    await reconcileFusion(h.deps, fusion.id)
    const f = await getFusion(h.deps, fusion.id)
    expect(f!.status).toBe('failed')
    expect(f!.error).toContain(memB)
  })
})
