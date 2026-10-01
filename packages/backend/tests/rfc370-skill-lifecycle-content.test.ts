// RFC-370 H6: await storage effects before publishing legacy adoption or boot
// availability. Real provider state remains owned by the existing AW workflow.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { skills, skillVersions } from '@/db/schema'
import type {
  SkillLifecycleContentStore,
  SkillSnapshotInspector,
} from '@/modules/resource-catalog/application/skills/lifecycleContentStore'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  ensureInitialSkillVersion,
  backfillLegacySkillVersions,
  reconcileSkillLiveFiles,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  activateBootReverify,
  isSkillBootVerified,
  resetSkillBootVerifyForTest,
  runBootSnapshotReverify,
} from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { createFileSkillLifecycleContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillLifecycleContentStore'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
async function reached(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('effect completed before storage step')
    }),
  ])
}
function inertStore(): SkillLifecycleContentStore {
  return {
    hasLiveMain: () => false,
    captureInitial: () => null,
    isRootEmpty: () => false,
    removeRoot() {},
    restoreLiveIfMissing() {},
  }
}

describeEachProvider('RFC-370 skill lifecycle content', (harness) => {
  let directory: string
  let appHome: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aw-skill-lifecycle-'))
    appHome = join(directory, 'absent-home')
    resetSkillBootVerifyForTest()
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    resetSkillBootVerifyForTest()
  })
  async function seed(name: string, reservationState: 'ready' | 'reserving' = 'ready') {
    const id = ulid()
    await harness.db
      .insert(skills)
      .values({ id, name, managedPath: `skills/${id}/files`, reservationState })
    return id
  }
  async function row(id: string) {
    return (await harness.db.select().from(skills).where(eq(skills.id, id)))[0]
  }
  async function versions(id: string) {
    return await harness.db.select().from(skillVersions).where(eq(skillVersions.skillId, id))
  }

  test('initial capture waits before version adoption and repeated calls do no storage work', async () => {
    const id = await seed('adopt')
    const entered = barrier(),
      ready = barrier()
    let captures = 0
    const content: SkillLifecycleContentStore = {
      ...inertStore(),
      async captureInitial(selected) {
        expect(selected).toBe(id)
        captures++
        entered.release()
        await ready.pending
        return 'a'.repeat(64)
      },
    }
    const pending = ensureInitialSkillVersion(
      harness.db,
      { appHome, lifecycleContent: content },
      id,
    )
    try {
      await reached(entered, pending)
      expect(await versions(id)).toEqual([])
      expect((await row(id))?.versionState).toBe('legacy-unbackfilled')
      expect(isSkillBootVerified(id)).toBe(false)
    } finally {
      ready.release()
    }
    await pending
    expect((await row(id))?.versionState).toBe('snapshot-authoritative')
    expect(await versions(id)).toMatchObject([
      { versionIndex: 1, contentHash: 'a'.repeat(64), source: 'initial' },
    ])
    expect(isSkillBootVerified(id)).toBe(true)
    await ensureInitialSkillVersion(harness.db, { appHome, lifecycleContent: content }, id)
    await ensureInitialSkillVersion(harness.db, { appHome, lifecycleContent: content }, 'missing')
    expect(captures).toBe(1)
    expect(existsSync(appHome)).toBe(false)
  })

  test('absent or failed initial capture leaves the legacy row and version history untouched', async () => {
    const id = await seed('absent')
    const opts = { appHome, lifecycleContent: inertStore() }
    await ensureInitialSkillVersion(harness.db, opts, id)
    const failure = new Error('capture unavailable')
    await expect(
      ensureInitialSkillVersion(
        harness.db,
        {
          ...opts,
          lifecycleContent: {
            ...inertStore(),
            async captureInitial() {
              throw failure
            },
          },
        },
        id,
      ),
    ).rejects.toBe(failure)
    expect(await versions(id)).toEqual([])
    expect((await row(id))?.versionState).toBe('legacy-unbackfilled')
    expect(isSkillBootVerified(id)).toBe(false)
  })

  test('boot sweep preserves content and reservations, and waits for empty-root cleanup', async () => {
    const kept = await seed('support-remains'),
      empty = await seed('empty-root'),
      reserved = await seed('reserved', 'reserving')
    const entered = barrier(),
      ready = barrier()
    const inspected: string[] = []
    const content: SkillLifecycleContentStore = {
      ...inertStore(),
      async hasLiveMain(id) {
        inspected.push(id)
        return false
      },
      async isRootEmpty(id) {
        return id === empty
      },
      async removeRoot(id) {
        expect(id).toBe(empty)
        entered.release()
        await ready.pending
      },
    }
    let settled = false
    const pending = backfillLegacySkillVersions(harness.db, {
      appHome,
      lifecycleContent: content,
    }).then((result) => {
      settled = true
      return result
    })
    try {
      await reached(entered, pending)
      expect(await row(empty)).toBeUndefined()
      expect(settled).toBe(false)
    } finally {
      ready.release()
    }
    expect(await pending).toEqual({ backfilled: 0, husksRemoved: 1 })
    expect(await row(kept)).toBeDefined()
    expect(await row(reserved)).toBeDefined()
    expect(inspected).not.toContain(reserved)
    const result = await backfillLegacySkillVersions(harness.db, {
      appHome,
      lifecycleContent: {
        ...inertStore(),
        async isRootEmpty() {
          throw new Error('inspection unavailable')
        },
      },
    })
    expect(result).toEqual({ backfilled: 0, husksRemoved: 0 })
    expect(await row(kept)).toBeDefined()
  })

  test('boot composition awaits missing-live restoration and snapshot inspection before availability', async () => {
    const created = await createManagedSkill(
      harness.db,
      { appHome: directory },
      {
        name: 'boot-selected',
        description: '',
        bodyMd: 'local body',
        frontmatterExtra: {},
      },
    )
    const restoreEntered = barrier(),
      restoreReady = barrier(),
      inspectEntered = barrier(),
      inspectReady = barrier()
    const calls: unknown[] = []
    const lifecycle: SkillLifecycleContentStore = {
      ...inertStore(),
      async restoreLiveIfMissing(id, version) {
        calls.push({ id, version })
        restoreEntered.release()
        await restoreReady.pending
      },
    }
    const inspector: SkillSnapshotInspector = {
      async inspect(input) {
        calls.push(input)
        inspectEntered.release()
        await inspectReady.pending
        return { ok: true }
      },
    }
    const boot = composeSkillCatalogBoot({
      db: harness.db,
      appHome,
      lifecycleContent: lifecycle,
      snapshotInspector: inspector,
    })
    boot.activateAvailabilityGate()
    const pending = boot.reconcileLiveFiles()
    try {
      await reached(restoreEntered, pending)
      expect(isSkillBootVerified(created.id)).toBe(false)
    } finally {
      restoreReady.release()
    }
    await pending
    const verifying = boot.reverifySnapshots()
    try {
      await reached(inspectEntered, verifying)
      expect(isSkillBootVerified(created.id)).toBe(false)
    } finally {
      inspectReady.release()
    }
    expect(await verifying).toEqual({ verified: 1, quarantined: 0 })
    expect(isSkillBootVerified(created.id)).toBe(true)
    expect(calls[0]).toEqual({ id: created.id, version: 1 })
    expect(calls[1]).toMatchObject({
      skillId: created.id,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          reference: `skills/${created.id}/versions/v1/files`,
          contentHash: expect.any(String),
        },
      ],
    })
    expect(existsSync(appHome)).toBe(false)
  })

  test('boot decisions retain full-history validation, storage failures and restored-content recovery', async () => {
    const created = await createManagedSkill(
      harness.db,
      { appHome: directory },
      {
        name: 'inspect-selected',
        description: '',
        bodyMd: 'body',
        frontmatterExtra: {},
      },
    )
    activateBootReverify()
    const fail: SkillSnapshotInspector = {
      async inspect() {
        throw new Error('snapshot unavailable')
      },
    }
    expect(await runBootSnapshotReverify(harness.db, { appHome, snapshotInspector: fail })).toEqual(
      { verified: 0, quarantined: 1 },
    )
    expect(isSkillBootVerified(created.id)).toBe(false)
    const ok: SkillSnapshotInspector = {
      async inspect() {
        return { ok: true }
      },
    }
    expect(await runBootSnapshotReverify(harness.db, { appHome, snapshotInspector: ok })).toEqual({
      verified: 1,
      quarantined: 0,
    })
    await harness.db.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, created.id))
    let inspected = false
    const counted: SkillSnapshotInspector = {
      inspect() {
        inspected = true
        return { ok: true }
      },
    }
    expect(
      await runBootSnapshotReverify(harness.db, { appHome, snapshotInspector: counted }),
    ).toEqual({ verified: 0, quarantined: 1 })
    expect(inspected).toBe(false)
  })

  test('file lifecycle keeps original snapshot bytes, existing-live edits and nonempty roots', async () => {
    const id = await seed('local-maintenance')
    const home = join(directory, 'real-home'),
      live = join(home, 'skills', id, 'files')
    mkdirSync(live, { recursive: true })
    writeFileSync(join(live, 'SKILL.md'), 'original')
    const content = createFileSkillLifecycleContentStore(home)
    await ensureInitialSkillVersion(harness.db, { appHome: home, lifecycleContent: content }, id)
    const snapshot = join(home, 'skills', id, 'versions', 'v1', 'files', 'SKILL.md')
    expect(readFileSync(snapshot, 'utf8')).toBe('original')
    writeFileSync(join(live, 'SKILL.md'), 'manual edit')
    await reconcileSkillLiveFiles(harness.db, { appHome: home, lifecycleContent: content })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('manual edit')
    rmSync(live, { recursive: true })
    await reconcileSkillLiveFiles(harness.db, { appHome: home, lifecycleContent: content })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('original')
    expect(await content.isRootEmpty(id)).toBe(false)
    await content.removeRoot(id)
    expect(await content.isRootEmpty(id)).toBe(true)
    expect(await content.captureInitial(id)).toBeNull()
  })
})
