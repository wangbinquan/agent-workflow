// RFC-370 H6: real DB phases around selected asynchronous identity effects.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills, skillVersions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { SkillIdentityContentStore } from '@/modules/resource-catalog/application/skills/identityContentStore'
import type { SkillIdentityInspector } from '@/modules/resource-catalog/application/skills/identityInspector'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { runSkillIdentityMigrationBarrier } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityMigration'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  skillFilesRel,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
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
      throw new Error('effect not reached')
    }),
  ])
}
const fingerprint = 'a'.repeat(64)
function remoteContent(): {
  state: { canonical: boolean }
  content: SkillIdentityContentStore
  inspector: SkillIdentityInspector
} {
  const state = { canonical: false }
  return {
    state,
    content: {
      plan: (identity) => ({
        ...identity,
        legacyRef: `content:${identity.legacyName}`,
        canonicalRef: `content:${identity.skillId}`,
      }),
      captureSource: () => fingerprint,
      move: () => {
        state.canonical = true
      },
      rollback: () => {
        state.canonical = false
      },
      rollForward: () => {
        state.canonical = true
      },
    },
    inspector: {
      prepare() {},
      assertOwnership() {},
      needsMigration: (row) => !row.canonicalMetadata || !state.canonical,
      prepareHuskSweep: () => ({ plan: () => null, discard() {} }),
      assertCanonicalRoot: () => {
        expect(state.canonical).toBe(true)
      },
      assertCanonicalLive() {},
      assertCanonicalVersion() {},
      assertNoResidue() {},
      assertPublishedReserve() {},
      assertCommittedDelete() {},
    },
  }
}

describeEachProvider('RFC-370 skill identity content', (harness) => {
  let directory: string, appHome: string, skillId: string
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aw-identity-content-'))
    appHome = join(directory, 'absent-home')
    const row = await createManagedSkill(
      harness.db,
      { appHome: directory },
      {
        name: 'identity-before',
        description: '',
        bodyMd: 'v1',
        frontmatterExtra: {},
      },
    )
    skillId = row.id
    await harness.db
      .update(skills)
      .set({ managedPath: 'skills/identity-before/files' })
      .where(eq(skills.id, skillId))
    await harness.db
      .update(skillVersions)
      .set({ filesPath: 'skills/identity-before/versions/v1/files' })
      .where(eq(skillVersions.skillId, skillId))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  async function managedPath() {
    return (
      await harness.db
        .select({ path: skills.managedPath })
        .from(skills)
        .where(eq(skills.id, skillId))
        .limit(1)
    )[0]?.path
  }

  test('boot composition awaits prepare/capture/move before publishing canonical DB references', async () => {
    const remote = remoteContent(),
      prepared = barrier(),
      start = barrier(),
      captured = barrier(),
      moving = barrier(),
      releaseMove = barrier()
    const calls: string[] = []
    remote.inspector.prepare = async () => {
      prepared.release()
      await start.pending
    }
    remote.content.captureSource = async () => {
      captured.release()
      return fingerprint
    }
    remote.content.move = async (plan, hash) => {
      expect(plan.canonicalRef).toBe(`content:${skillId}`)
      expect(hash).toBe(fingerprint)
      moving.release()
      await releaseMove.pending
      remote.state.canonical = true
    }
    remote.inspector.assertCanonicalVersion = async (id, version) => {
      calls.push(`${id}:v${version}`)
    }
    const pending = composeSkillCatalogBoot({
      db: harness.db,
      appHome,
      identityContent: remote.content,
      identityInspector: remote.inspector,
    }).runIdentityMigrationBarrier()
    try {
      await reached(prepared, pending)
      expect(await getActiveOp(harness.db, skillId)).toBeNull()
      expect(existsSync(appHome)).toBe(false)
      start.release()
      await reached(captured, pending)
      await reached(moving, pending)
      expect((await getActiveOp(harness.db, skillId))?.phase).toBe('intent')
      expect(await managedPath()).toBe('skills/identity-before/files')
      releaseMove.release()
      expect(await pending).toEqual({
        recoveredOperations: 0,
        removedHusks: 0,
        migratedSkills: 1,
        verifiedSkills: 1,
        verifiedVersions: 1,
      })
      expect(await managedPath()).toBe(skillFilesRel(skillId))
      expect(calls).toEqual([`${skillId}:v1`])
      expect(await getActiveOp(harness.db, skillId)).toBeNull()
      expect(existsSync(appHome)).toBe(false)
    } finally {
      start.release()
      releaseMove.release()
      await pending.catch(() => {})
    }
  })

  for (const phase of ['fs-staged', 'db-committed'] as const) {
    test(`restart awaits selected ${phase === 'fs-staged' ? 'rollback' : 'rollforward'} with the persisted fingerprint`, async () => {
      const remote = remoteContent()
      await expect(
        runSkillIdentityMigrationBarrier(harness.db, {
          appHome,
          identityContent: remote.content,
          identityInspector: remote.inspector,
          hooks: {
            afterPhase(current) {
              if (current === phase) throw new Error(`crash:${phase}`)
            },
          },
        }),
      ).rejects.toThrow(`crash:${phase}`)
      const active = await getActiveOp(harness.db, skillId)
      expect(active?.phase).toBe(phase)
      const recovery = barrier(),
        releaseRecovery = barrier()
      const seen: string[] = []
      const selected = phase === 'fs-staged' ? 'rollback' : 'rollForward'
      remote.content[selected] = async (plan, hash) => {
        seen.push(hash)
        expect(plan.skillId).toBe(skillId)
        recovery.release()
        await releaseRecovery.pending
        remote.state.canonical = selected === 'rollForward'
      }
      const pending = runSkillIdentityMigrationBarrier(harness.db, {
        appHome,
        identityContent: remote.content,
        identityInspector: remote.inspector,
      })
      try {
        await reached(recovery, pending)
        expect((await getActiveOp(harness.db, skillId))?.opId).toBe(active!.opId)
        expect(await managedPath()).toBe(
          phase === 'fs-staged' ? 'skills/identity-before/files' : skillFilesRel(skillId),
        )
        releaseRecovery.release()
        const result = await pending
        expect(result.recoveredOperations).toBe(1)
        expect(result.migratedSkills).toBe(phase === 'fs-staged' ? 1 : 0)
        expect(seen).toEqual([active!.candidateFingerprint!])
        expect(await getActiveOp(harness.db, skillId)).toBeNull()
        expect(await managedPath()).toBe(skillFilesRel(skillId))
        expect(existsSync(appHome)).toBe(false)
      } finally {
        releaseRecovery.release()
        await pending.catch(() => {})
      }
    })
  }

  test('a failed move preserves the active operation and retries through the same recovery selection', async () => {
    const remote = remoteContent(),
      error = new Error('content unavailable')
    remote.content.move = async () => {
      throw error
    }
    await expect(
      runSkillIdentityMigrationBarrier(harness.db, {
        appHome,
        identityContent: remote.content,
        identityInspector: remote.inspector,
      }),
    ).rejects.toBe(error)
    expect((await getActiveOp(harness.db, skillId))?.phase).toBe('intent')
    expect(await managedPath()).toBe('skills/identity-before/files')
    remote.content.rollback = async () => {
      throw error
    }
    await expect(
      runSkillIdentityMigrationBarrier(harness.db, {
        appHome,
        identityContent: remote.content,
        identityInspector: remote.inspector,
      }),
    ).rejects.toBe(error)
    expect((await getActiveOp(harness.db, skillId))?.phase).toBe('intent')
    remote.content.rollback = async () => {
      remote.state.canonical = false
    }
    remote.content.move = async () => {
      remote.state.canonical = true
    }
    expect(
      (
        await runSkillIdentityMigrationBarrier(harness.db, {
          appHome,
          identityContent: remote.content,
          identityInspector: remote.inspector,
        })
      ).recoveredOperations,
    ).toBe(1)
    expect(await managedPath()).toBe(skillFilesRel(skillId))
  })

  test('husk cleanup waits after DB deletion and uses the selected content receipt', async () => {
    await harness.db.delete(skillVersions).where(eq(skillVersions.skillId, skillId))
    await harness.db
      .update(skills)
      .set({ versionState: 'legacy-unbackfilled', contentVersion: 0 })
      .where(eq(skills.id, skillId))
    const remote = remoteContent(),
      discarding = barrier(),
      releaseDiscard = barrier()
    const plan = { skillId, contentRefs: ['content:empty-husk'] }
    remote.inspector.prepareHuskSweep = async (rows) => {
      expect(rows.map((row) => row.id)).toContain(skillId)
      return {
        plan: async () => plan,
        discard: async (selected) => {
          expect(selected).toBe(plan)
          discarding.release()
          await releaseDiscard.pending
        },
      }
    }
    const pending = runSkillIdentityMigrationBarrier(harness.db, {
      appHome,
      identityContent: remote.content,
      identityInspector: remote.inspector,
    })
    try {
      await reached(discarding, pending)
      expect(await managedPath()).toBeUndefined()
      releaseDiscard.release()
      expect(await pending).toEqual({
        recoveredOperations: 0,
        removedHusks: 1,
        migratedSkills: 0,
        verifiedSkills: 0,
        verifiedVersions: 0,
      })
      expect(existsSync(appHome)).toBe(false)
    } finally {
      releaseDiscard.release()
      await pending.catch(() => {})
    }
  })

  test('published reserve storage proof waits before its operation is retired', async () => {
    await harness.db
      .update(skills)
      .set({ managedPath: skillFilesRel(skillId) })
      .where(eq(skills.id, skillId))
    await harness.db
      .update(skillVersions)
      .set({ filesPath: skillVersionRelPath(skillId, 1) })
      .where(eq(skillVersions.skillId, skillId))
    const version = (
      await harness.db
        .select({ hash: skillVersions.contentHash })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skillId))
        .limit(1)
    )[0]!
    const opId = await databaseSessionFor(harness.db).transaction(async (tx) => {
      const id = await beginOperation(tx, {
        kind: 'reserve',
        skillId,
        preconditionJson: JSON.stringify({ skillId }),
      })
      await advancePhase(tx, id, 'fs-staged')
      await advancePhase(tx, id, 'fs-published')
      await advancePhase(tx, id, 'db-committed')
      return id
    })
    const remote = remoteContent(),
      proving = barrier(),
      releaseProof = barrier()
    remote.state.canonical = true
    remote.inspector.assertPublishedReserve = async (input) => {
      expect(input).toEqual({ skillId, operationId: opId, contentHash: version.hash })
      proving.release()
      await releaseProof.pending
    }
    const pending = runSkillIdentityMigrationBarrier(harness.db, {
      appHome,
      identityContent: remote.content,
      identityInspector: remote.inspector,
    })
    try {
      await reached(proving, pending)
      expect((await getActiveOp(harness.db, skillId))?.opId).toBe(opId)
      releaseProof.release()
      expect((await pending).recoveredOperations).toBe(1)
      expect(await getActiveOp(harness.db, skillId)).toBeNull()
      expect(existsSync(appHome)).toBe(false)
    } finally {
      releaseProof.release()
      await pending.catch(() => {})
    }
  })
})
