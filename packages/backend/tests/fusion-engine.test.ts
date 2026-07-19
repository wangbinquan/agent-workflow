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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join as pjoin } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { fusions, memories, skillVersions, tasks } from '../src/db/schema'
import {
  approveFusion,
  cancelFusion,
  createFusion,
  getFusion,
  isValidFusionTransition,
  reconcileFusion,
  recoverFusionDecisions,
  rejectFusion,
  type FusionDeps,
} from '../src/services/fusion'
import { getTask } from '../src/services/task'
import { createManagedSkill, type SkillFsOptions } from '../src/services/skill'
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
  const path = pjoin(dir, 'stub-opencode.sh')
  const env =
    '{\\"questions\\":[{\\"id\\":\\"q1\\",\\"title\\":\\"Proceed?\\",\\"kind\\":\\"single\\",\\"options\\":[{\\"label\\":\\"yes\\"},{\\"label\\":\\"no\\"}]}]}</workflow-clarify>'
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s\\n' "$@" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OPEN='<workflow-clarify>'; if [[ -n "$NONCE" ]]; then OPEN='<workflow-clarify nonce=\\"'"$NONCE"'\\">'; fi
  ENV="$OPEN"'${env}'
  TS=$(date +%s)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
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
    opencodeCmd: [makeClarifyStub(tmp)],
    awaitScheduler: true,
  }
  return { db, appHome, deps, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
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

function fusionWorkRoots(appHome: string): string[] {
  const root = pjoin(appHome, 'fusions')
  if (!existsSync(root)) return []
  const workRoots: string[] = []
  for (const fusionId of readdirSync(root)) {
    const fusionRoot = pjoin(root, fusionId)
    if (!existsSync(fusionRoot)) continue
    for (const iteration of readdirSync(fusionRoot)) {
      const work = pjoin(fusionRoot, iteration, 'work')
      if (existsSync(work)) workRoots.push(work)
    }
  }
  return workRoots
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

  test('seedWorktree git failure removes the owned root before startTask handoff', async () => {
    await createManagedSkill(h.db, { appHome: h.appHome } as SkillFsOptions, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const deps: FusionDeps = {
      ...h.deps,
      seedGit: async () => ({ stdout: '', stderr: 'injected seed failure', exitCode: 73 }),
    }
    await expect(
      createFusion({ skillName: 'lint', memoryIds: [mem], intent: '' }, deps, adminActor),
    ).rejects.toThrow(/injected seed failure/)

    expect(h.db.select().from(tasks).all()).toHaveLength(0)
    expect(h.db.select().from(fusions).all()).toHaveLength(0)
    expect(fusionWorkRoots(h.appHome)).toEqual([])
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

    // RFC-170 T6: the composite precondition token drifted (contentVersion 1→2),
    // so approve is rejected EARLY — before any state change (zero side effect) —
    // instead of transitioning to 'applying' then failing inside commitSkillVersion.
    // The fusion is PRESERVED as awaiting_approval; the user re-initiates against
    // the current skill (both approve and re-run reject a drifted fusion).
    await expect(approveFusion(h.deps, fusion.id, adminActor)).rejects.toThrow(
      /precondition|changed/i,
    )
    const stale = await getFusion(h.deps, fusion.id)
    expect(stale!.status).toBe('awaiting_approval') // preserved, not 'failed'
    expect(statusOf(h.db, mem)).toBe('approved') // not fused
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

// RFC-170 T6 — the fusion captures the target skill's composite precondition
// token at create time; approve AND re-run CAS it against the live token. A
// delete→recreate ABA (new skillId under the same name — baseSkillVersion alone
// can't see it), a concurrent edit, or a legacy (pre-upgrade, null-token) fusion
// are all rejected with ZERO side effects, forcing the user to re-initiate.
describe('RFC-170 T6 — fusion precondition token', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  /** Drive a fresh fusion to awaiting_approval (agent worktree edit simulated). */
  async function toAwaitingApproval(skillName: string, memId: string) {
    const fusion = await createFusion(
      { skillName, memoryIds: [memId], intent: '' },
      h.deps,
      adminActor,
    )
    const task = await getTask(h.db, fusion.currentTaskId!)
    const wt = task!.worktreePath
    writeFileSync(pjoin(wt, 'SKILL.md'), `---\nname: ${skillName}\ndescription: d\n---\nproposed`)
    mkdirSync(pjoin(wt, '__fusion__'), { recursive: true })
    writeFileSync(
      pjoin(wt, '__fusion__', 'result.json'),
      JSON.stringify({ incorporatedMemoryIds: [memId], skipped: [], changelog: 'x' }),
    )
    h.db
      .update(tasks)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(tasks.id, task!.id))
      .run()
    await reconcileFusion(h.deps, fusion.id)
    return fusion
  }

  function tokenOf(fusionId: string): string | null {
    return (
      h.db.select().from(fusions).where(eq(fusions.id, fusionId)).all() as Array<{
        preconditionToken: string | null
      }>
    )[0]!.preconditionToken
  }

  test('createFusion persists a non-null composite token', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [mem], intent: '' },
      h.deps,
      adminActor,
    )
    expect(tokenOf(fusion.id)).not.toBeNull()
  })

  test('approve on a LEGACY (null-token) fusion is fail-closed (409), status preserved', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    // Simulate a pre-upgrade fusion: no captured token.
    h.db.update(fusions).set({ preconditionToken: null }).where(eq(fusions.id, fusion.id)).run()

    await expect(approveFusion(h.deps, fusion.id, adminActor)).rejects.toThrow(
      /predates|precondition/i,
    )
    expect((await getFusion(h.deps, fusion.id))!.status).toBe('awaiting_approval')
    expect(statusOf(h.db, mem)).toBe('approved') // not fused
  })

  test('re-run (reject) on a drifted skill is a zero-side-effect 409 (no new task)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    const taskBefore = fusion.currentTaskId

    // A concurrent editor bumps the skill (token drifts).
    const { writeSkillContent } = await import('../src/services/skill')
    await writeSkillContent(h.db, fsOpts, 'lint', { bodyMd: 'edited elsewhere' }, 'someone')

    await expect(rejectFusion(h.deps, fusion.id, 'try again', adminActor)).rejects.toThrow(
      /precondition|changed/i,
    )
    const after = await getFusion(h.deps, fusion.id)
    // Zero side effects: still awaiting_approval, same iteration, same task, not re-run.
    expect(after!.status).toBe('awaiting_approval')
    expect(after!.iteration).toBe(1)
    expect(after!.currentTaskId).toBe(taskBefore)
  })

  test('rejectFusion pre-startTask failure removes the next-iteration owned root', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    const taskCountBefore = h.db.select().from(tasks).all().length
    const deps: FusionDeps = {
      ...h.deps,
      beforeStartTaskHandoff: ({ phase }) => {
        if (phase === 'reject') throw new Error('injected reject pre-handoff failure')
      },
    }
    await expect(rejectFusion(deps, fusion.id, 'retry', adminActor)).rejects.toThrow(
      /injected reject pre-handoff failure/,
    )

    expect(h.db.select().from(tasks).all()).toHaveLength(taskCountBefore)
    expect(existsSync(pjoin(h.appHome, 'fusions', fusion.id, 'iter2', 'work'))).toBe(false)
    expect((await getFusion(h.deps, fusion.id))!.status).toBe('failed')
  })

  test('happy path: an unchanged skill still approves (token matches)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    // No skill drift → token matches → approve succeeds + fuses the memory.
    const done = await approveFusion(h.deps, fusion.id, adminActor)
    expect(done.status).toBe('done')
    expect(statusOf(h.db, mem)).toBe('fused')
  })

  // RFC-170 T6 (Codex F4/F5) — the atomic status claim serialises decisions: once
  // a fusion leaves awaiting_approval, no second decision can proceed (the loser's
  // claim fails), so a completed fusion can't be double-applied or overwritten.
  test('a second approve after one succeeds is rejected (no double-apply)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    await approveFusion(h.deps, fusion.id, adminActor) // wins the claim → done
    // The fusion is no longer awaiting_approval → the second claim fails.
    await expect(approveFusion(h.deps, fusion.id, adminActor)).rejects.toThrow(/awaiting/i)
    expect((await getFusion(h.deps, fusion.id))!.status).toBe('done') // not overwritten
    expect(statusOf(h.db, mem)).toBe('fused') // fused exactly once
  })

  test('reject after a decision already moved the fusion is rejected (atomic claim)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    await rejectFusion(h.deps, fusion.id, 'redo', adminActor) // claims → running (iter 2)
    // No longer awaiting_approval → a second reject can't create a duplicate task.
    await expect(rejectFusion(h.deps, fusion.id, 'again', adminActor)).rejects.toThrow(/awaiting/i)
    expect((await getFusion(h.deps, fusion.id))!.iteration).toBe(2) // only one re-run
  })

  // RFC-170 T6 (Codex F4/F5) — a managed ACL transfer does NOT drift the token, so
  // both decision paths must independently re-check CURRENT skill write access
  // (else the fusion owner writes into a skill they transferred away). The full
  // behavioral path needs a non-admin owner + manageable memory; this source lock
  // guarantees a refactor can't silently drop the recheck from either path.
  test('approve + reject both re-check current skill ownership (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // Both decision entry points call the recheck helper before claiming.
    const calls = src.match(/requireCurrentSkillWritable\(db, actor, row\.skillName\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2) // approve + reject
    expect(src).toMatch(/!isResourceOwner\(actor, skill\)/) // helper gates on current owner
  })

  // RFC-170 T6 (Codex re-review F8): the owner recheck is ALSO folded into the
  // claim tx (a managed transfer doesn't drift the token, so an out-of-tx check is
  // TOCTOU). Locks that claimFusionDecision authorises against the CURRENT owner
  // atomically with the status transition.
  test('claimFusionDecision re-checks the current owner in-tx (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    expect(src).toMatch(/live!\.ownerUserId !== actor\.user\.id/)
  })

  // RFC-170 T6 (Codex re-review F10): a null precondition token at create time
  // (skill vanished / unpublished) is rejected BEFORE any worktree/task is made.
  test('createFusion rejects a null precondition token before side effects (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // The null check sits between the token capture and the memory/seed/startTask.
    expect(src).toMatch(/if \(preconditionToken === null\)/)
  })

  // RFC-170 T6 (Codex re-review F7): every fusion status writer is a generation-CAS
  // on (status, currentTaskId) — no writer clobbers a concurrent decision.
  test('cancel is rejected once a fusion is applying (F7 CAS — no cancel mid-approve)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await toAwaitingApproval('lint', mem)
    // Simulate an in-flight approve that has claimed 'applying'.
    h.db.update(fusions).set({ status: 'applying' }).where(eq(fusions.id, fusion.id)).run()
    await expect(cancelFusion(h.deps, fusion.id, adminActor)).rejects.toThrow(
      /cancelable|terminal/i,
    )
    expect((await getFusion(h.deps, fusion.id))!.status).toBe('applying') // not canceled
  })

  test('reconcile + reject-attach + cancel all write via casFusionStatus (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // The old unconditional setFusionStatus/failFusion are gone.
    expect(src).not.toMatch(/^function setFusionStatus\(/m)
    expect(src).not.toMatch(/^function failFusion\(/m)
    // reconcile write-back + reject attach both CAS on currentTaskId.
    const casCalls = src.match(/casFusionStatus\(/g) ?? []
    expect(casCalls.length).toBeGreaterThanOrEqual(5) // reconcile(×3) + reject(×2) + cancel + approve
    expect(src).toMatch(/expectCurrentTaskId: taskId/) // reconcile keys on the task it read
    expect(src).toMatch(/expectCurrentTaskId: null/) // reject attach keys on the null intermediate
  })
})

// RFC-170 T6 (Codex re-review F9) — boot recovery for fusion decision half-states
// left by a daemon crash mid-approve / mid-reject.
describe('RFC-170 T6 F9 — recoverFusionDecisions (crash recovery)', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  beforeEach(async () => {
    // A real 'lint' skill so skill_versions FK inserts succeed.
    await createManagedSkill(h.db, { appHome: h.appHome } as SkillFsOptions, {
      name: 'lint',
      description: 'd',
      bodyMd: 'orig',
      frontmatterExtra: {},
    })
  })

  function seedFusion(id: string, patch: Partial<typeof fusions.$inferInsert>): void {
    h.db
      .insert(fusions)
      .values({
        id,
        skillName: 'lint',
        baseSkillVersion: 1,
        memoryIdsJson: '[]',
        intent: '',
        status: 'running',
        iteration: 1,
        currentTaskId: 'task-x',
        ownerUserId: '__system__',
        createdAt: Date.now(),
        ...patch,
      })
      .run()
  }

  // Read status DIRECTLY (getFusion lazily reconciles a running fusion whose task
  // is missing, which would mask what recoverFusionDecisions actually did).
  function rawStatus(id: string): string | undefined {
    return (
      h.db
        .select({ status: fusions.status })
        .from(fusions)
        .where(eq(fusions.id, id))
        .all() as Array<{
        status: string
      }>
    )[0]?.status
  }

  test("'applying' whose version already committed rolls FORWARD to done", () => {
    seedFusion('fz-fwd', { status: 'applying', currentTaskId: null })
    // A committed version carries this fusionId (proof the apply landed durably).
    h.db
      .insert(skillVersions)
      .values({
        id: ulid(),
        skillName: 'lint',
        versionIndex: 7,
        filesPath: 'skills/lint/versions/v7/files',
        source: 'fusion',
        fusionId: 'fz-fwd',
        authorUserId: '__system__',
        createdAt: Date.now(),
      })
      .run()
    const r = recoverFusionDecisions(h.db)
    expect(r.rolledForward).toBe(1)
    expect(rawStatus('fz-fwd')).toBe('done')
  })

  test("'applying' with NO committed version rolls BACK to failed", () => {
    seedFusion('fz-back', { status: 'applying', currentTaskId: null })
    const r = recoverFusionDecisions(h.db)
    expect(r.rolledBack).toBe(1)
    expect(rawStatus('fz-back')).toBe('failed')
  })

  test("'running' with currentTaskId=null (reject that never attached) → failed", () => {
    seedFusion('fz-rej', { status: 'running', currentTaskId: null })
    const r = recoverFusionDecisions(h.db)
    expect(r.rejectFailed).toBe(1)
    expect(rawStatus('fz-rej')).toBe('failed')
  })

  test('a normal running fusion (task in flight) is NOT touched', () => {
    seedFusion('fz-live', { status: 'running', currentTaskId: 'task-live' })
    const r = recoverFusionDecisions(h.db)
    expect(r.rolledForward + r.rolledBack + r.rejectFailed).toBe(0)
    expect(rawStatus('fz-live')).toBe('running')
  })
})

// RFC-170 T6 (Codex re-review F10) — a fusion worktree is seeded from the token's
// IMMUTABLE version snapshot, not the mutable live dir, so tampering with live (or
// a delete→recreate) between authorization and the copy can't feed the agent a
// different generation's content.
describe('RFC-170 T6 F10 — fusion seeds from the version snapshot, not live', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('createFusion seeds from versions/v1, ignoring tampered live files', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'SNAPSHOT-BODY',
      frontmatterExtra: {},
    })
    // Tamper the LIVE files directly (no version bump → token still points at v1).
    writeFileSync(
      pjoin(h.appHome, 'skills', 'lint', 'files', 'SKILL.md'),
      '---\nname: lint\ndescription: d\n---\nLIVE-TAMPERED',
    )
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [mem], intent: '' },
      h.deps,
      adminActor,
    )
    const task = await getTask(h.db, fusion.currentTaskId!)
    const seeded = readFileSync(pjoin(task!.worktreePath, 'SKILL.md'), 'utf8')
    expect(seeded).toContain('SNAPSHOT-BODY') // from the immutable v1 snapshot
    expect(seeded).not.toContain('LIVE-TAMPERED') // NOT from the mutated live dir
  })

  // RFC-170 T6 (Codex re-review F11): the seed is keyed to the token's skillId
  // (not just name+version), and fails closed with no live fallback.
  test('createFusion fails closed when the target has no version snapshot (F11)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    // Remove the snapshot dir (legacy/corrupted skill) → no safe seed source.
    rmSync(pjoin(h.appHome, 'skills', 'lint', 'versions'), { recursive: true, force: true })
    const mem = approvedGlobalMemory(h.db, 'm')
    let code: string | undefined
    try {
      await createFusion({ skillName: 'lint', memoryIds: [mem], intent: '' }, h.deps, adminActor)
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('fusion-skill-unversioned') // fail-closed, NOT empty/live seed
  })

  test('seedFusionFromSnapshot verifies the token skillId around the copy (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // Generation check keys on the token's skillId, not just (name, version).
    expect(src).toMatch(/s\.id === t\.skillId && s\.contentVersion === t\.contentVersion/)
    // No live fallback remains.
    expect(src).not.toMatch(/return existsSync\(snapshot\) \? snapshot : live/)
  })

  // RFC-170 T6 (Codex re-review F11-deeper): the token is bound to the AUTHORIZED
  // skill row's immutable id, not a by-name re-read that a same-name recreate could
  // repoint to a different (private) skill B.
  test('createFusion binds the token to the authorized skill id (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    expect(src).toMatch(/getSkillPreconditionTokenById\(db, skill\.id\)/)
    expect(src).not.toMatch(/getSkillPreconditionToken\(db, input\.skillName\)/) // no by-name re-read
  })
})

// RFC-170 T6 (Codex re-review F12) — cancel captures the CURRENT task in its CAS
// and terminalizes parked (awaiting_human) engine tasks so nothing is orphaned.
describe('RFC-170 T6 F12 — cancel is generation-safe + covers parked tasks', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('cancelFusion terminalizes the parked engine task (F12 parked handling)', async () => {
    const fsOpts: SkillFsOptions = { appHome: h.appHome }
    await createManagedSkill(h.db, fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    const mem = approvedGlobalMemory(h.db, 'm')
    const fusion = await createFusion(
      { skillName: 'lint', memoryIds: [mem], intent: '' },
      h.deps,
      adminActor,
    )
    const taskId = fusion.currentTaskId! // parked in its mandatory clarify round
    const res = await cancelFusion(h.deps, fusion.id, adminActor)
    expect(res.status).toBe('canceled')
    // The parked engine task was terminalized (not orphaned in the clarify inbox).
    const task = await getTask(h.db, taskId)
    expect(task!.status).toBe('canceled')
  })

  test('cancel claim captures currentTaskId in the CAS (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // The cancel claim reads + returns currentTaskId, then cancels THAT exact task.
    expect(src).toMatch(/return \{ ok: true as const, taskId: cur\.currentTaskId \}/)
    expect(src).toMatch(/if \(claim\.taskId !== null\) await cancelFusionEngineTask/)
  })

  // RFC-170 T6 (Codex re-review F12-deeper): cancelFusionEngineTask RE-READS and
  // retries until the task is terminal — a state flip between read and cancel no
  // longer silently drops the cancel.
  test('cancelFusionEngineTask retries until terminal, not read-once (source lock)', () => {
    const src = readFileSync(pjoin(__dirname, '..', 'src', 'services', 'fusion.ts'), 'utf8')
    // A bounded retry loop that returns only on a gone/terminal task.
    expect(src).toMatch(/for \(let attempt = 0; attempt < 8; attempt\+\+\)/)
    expect(src).toMatch(/if \(task === null \|\| TERMINAL_TASK\.has\(task\.status\)\) return/)
  })
})
