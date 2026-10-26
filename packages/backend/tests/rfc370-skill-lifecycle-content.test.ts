// RFC-370 H6: await storage effects before publishing legacy adoption or boot
// availability. Real provider state remains owned by the existing AW workflow.

import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  SkillLifecycleContentStore,
  SkillSnapshotInspector,
} from '@/modules/resource-catalog/application/skills/lifecycleContentStore'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { reconcileSkillLiveFiles } from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
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
  // Frozen capture/adoption failures and empty-husk disposition are converter cases in rfc370-skill-identity-content.test.ts.

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
    const { skills } = tablesOf(harness.db)
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
    const home = join(directory, 'real-home')
    const created = await createManagedSkill(
      harness.db,
      { appHome: home },
      {
        name: 'local-maintenance',
        description: '',
        bodyMd: 'original',
        frontmatterExtra: {},
      },
    )
    const id = created.id,
      live = join(home, 'skills', id, 'files')
    const original = readFileSync(join(live, 'SKILL.md'), 'utf8')
    const content = createFileSkillLifecycleContentStore(home)
    const snapshot = join(home, 'skills', id, 'versions', 'v1', 'files', 'SKILL.md')
    expect(readFileSync(snapshot, 'utf8')).toBe(original)
    writeFileSync(join(live, 'SKILL.md'), 'manual edit')
    await reconcileSkillLiveFiles(harness.db, { appHome: home, lifecycleContent: content })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('manual edit')
    rmSync(live, { recursive: true })
    await reconcileSkillLiveFiles(harness.db, { appHome: home, lifecycleContent: content })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe(original)
    expect(await content.isRootEmpty(id)).toBe(false)
    await content.removeRoot(id)
    expect(await content.isRootEmpty(id)).toBe(true)
    expect(await content.captureInitial(id)).toBeNull()
  })
})
