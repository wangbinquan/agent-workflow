// RFC-370 A2: real HTTP editing and boot recovery share the selected skill
// content capabilities; leaf state machines and local mechanisms stay intact.
import { expect, test, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills, skillOperations, skillOperationLocks } from '@/db/schema'
import {
  selectSkillContentDependencies,
  type SkillContentBinding,
} from '@/modules/resource-catalog/composition/skillContentBinding'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { createFileSkillContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'
import { createFileSkillVersionContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentReader'
import { createFileSkillCreationContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillCreationContentStore'
import { createFileSkillDeletionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillDeletionContentStore'
import { createFileSkillLifecycleContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillLifecycleContentStore'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { createFileSkillVersionPresenceQueries } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionPresenceQueries'
import { createFileSkillSnapshotInspector } from '@/modules/resource-catalog/infrastructure/local/fileSkillSnapshotInspector'
import { createFileSkillVersionRecoveryContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionRecoveryContentStore'
import { createFileSkillIdentityContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillIdentityContentStore'
import { createFileSkillIdentityInspector } from '@/modules/resource-catalog/infrastructure/local/fileSkillIdentityInspector'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

function binding(rootReference: string): SkillContentBinding {
  return Object.freeze({
    rootReference,
    content: createFileSkillContentReader(rootReference),
    versionReader: createFileSkillVersionContentReader(rootReference),
    creationContent: createFileSkillCreationContentStore(rootReference),
    deletionContent: createFileSkillDeletionContentStore(rootReference),
    lifecycleContent: createFileSkillLifecycleContentStore(rootReference),
    versionContent: createFileSkillVersionContentStore(rootReference),
    versionPresence: createFileSkillVersionPresenceQueries(rootReference),
    snapshotInspector: createFileSkillSnapshotInspector(rootReference),
    versionRecovery: createFileSkillVersionRecoveryContentStore(rootReference),
    identityContent: createFileSkillIdentityContentStore(rootReference),
    identityInspector: createFileSkillIdentityInspector(rootReference),
  })
}
function inheritedBinding(store: SkillContentBinding): SkillContentBinding {
  class InheritedBinding implements SkillContentBinding {
    get rootReference() {
      expect(this).toBe(receiver)
      return store.rootReference
    }
    get content() {
      expect(this).toBe(receiver)
      return store.content
    }
    get versionReader() {
      expect(this).toBe(receiver)
      return store.versionReader
    }
    get creationContent() {
      expect(this).toBe(receiver)
      return store.creationContent
    }
    get deletionContent() {
      expect(this).toBe(receiver)
      return store.deletionContent
    }
    get lifecycleContent() {
      expect(this).toBe(receiver)
      return store.lifecycleContent
    }
    get versionContent() {
      expect(this).toBe(receiver)
      return store.versionContent
    }
    get versionPresence() {
      expect(this).toBe(receiver)
      return store.versionPresence
    }
    get snapshotInspector() {
      expect(this).toBe(receiver)
      return store.snapshotInspector
    }
    get versionRecovery() {
      expect(this).toBe(receiver)
      return store.versionRecovery
    }
    get identityContent() {
      expect(this).toBe(receiver)
      return store.identityContent
    }
    get identityInspector() {
      expect(this).toBe(receiver)
      return store.identityInspector
    }
  }
  const receiver: SkillContentBinding = Object.freeze(new InheritedBinding())
  expect(Object.keys(receiver)).toEqual([])
  return receiver
}

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

afterEach(resetSkillBootVerifyForTest)

describeEachProviderHttpApplication(
  'RFC-370 true skill content root binding',
  {
    token: 'b'.repeat(64),
    opencodeVersion: null,
    dbVersion: 17,
    tempPrefix: 'aw-rfc370-skill-root-',
  },
  (scope) => {
    let selectedHome: string | undefined
    afterEach(() => {
      if (selectedHome !== undefined) rmSync(selectedHome, { recursive: true, force: true })
      selectedHome = undefined
    })
    function selected() {
      selectedHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-selected-skill-'))
      return binding(selectedHome)
    }
    const headers = {
      Authorization: `Bearer ${'b'.repeat(64)}`,
      'content-type': 'application/json',
    }
    for (const representation of ['own', 'inherited'] as const) {
      test(`HTTP ${representation} bundle waits for selected publication, reads the exact version and boot recovers it`, async () => {
        const store = selected()
        const entered = barrier(),
          release = barrier()
        const versionContent: SkillContentBinding['versionContent'] = {
          ...store.versionContent,
          async publish(publication, hash) {
            expect(this).toBe(versionContent)
            entered.release()
            await release.pending
            await store.versionContent.publish(publication, hash)
          },
        }
        const inspected = barrier(),
          inspectionReady = barrier()
        const snapshotInspector: SkillContentBinding['snapshotInspector'] = {
          async inspect(input) {
            expect(this).toBe(snapshotInspector)
            expect(input.currentVersion).toBe(1)
            inspected.release()
            await inspectionReady.pending
            return await store.snapshotInspector.inspect(input)
          },
        }
        const complete = Object.freeze({ ...store, versionContent, snapshotInspector })
        const selection = representation === 'own' ? complete : inheritedBinding(complete)
        let recovery: Promise<{ verified: number; quarantined: number }> | undefined
        const { app, appHome } = await scope.open({ skillContent: selection })
        const pending = Promise.resolve(
          app.request('/api/skills', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: 'root-selected',
              bodyMd: 'selected body',
              description: 'selected description',
            }),
          }),
        )
        try {
          await Promise.race([
            entered.pending,
            pending.then(async (response) => {
              throw new Error(
                `selected publish ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          const before = await scope.harness.db.select().from(skills)
          expect(before).toHaveLength(1)
          expect(before[0]).toMatchObject({ reservationState: 'reserving', contentVersion: 1 })
          expect(await scope.harness.db.select().from(skillOperationLocks)).toHaveLength(1)
          release.release()
          const response = await pending
          expect(response.status).toBe(201)
          const created = (await response.json()) as { id: string }
          const read = await app.request(`/api/skills/${created.id}/content`, { headers })
          expect(read.status).toBe(200)
          expect(await read.json()).toMatchObject({ bodyMd: 'selected body' })
          expect(await scope.harness.db.select().from(skillOperationLocks)).toEqual([])
          expect((await scope.harness.db.select().from(skillOperations))[0]).toMatchObject({
            phase: 'done',
            active: 0,
          })
          expect(existsSync(join(appHome, 'skills', created.id))).toBe(false)
          expect(
            existsSync(
              join(
                store.rootReference,
                'skills',
                created.id,
                'versions',
                'v1',
                'files',
                'SKILL.md',
              ),
            ),
          ).toBe(true)
          const boot = composeSkillCatalogBoot({
            db: scope.harness.db,
            ...selectSkillContentDependencies(selection, appHome),
          })
          await boot.runIdentityMigrationBarrier()
          await boot.reconcileLiveFiles()
          let recovered = false
          recovery = boot.reverifySnapshots().then((report) => {
            recovered = true
            return report
          })
          await Promise.race([
            inspected.pending,
            recovery.then(() => {
              throw new Error('selected boot inspection ACK missed')
            }),
          ])
          expect(recovered).toBe(false)
          inspectionReady.release()
          expect(await recovery).toEqual({ verified: 1, quarantined: 0 })
          expect(
            (await scope.harness.db.select().from(skills).where(eq(skills.id, created.id)))[0],
          ).toMatchObject({ reservationState: 'ready', contentVersion: 1 })
        } finally {
          release.release()
          inspectionReady.release()
          await pending
          await recovery
        }
      }, 20_000)

      test(`a selected ${representation} read failure is returned instead of using a different local reader`, async () => {
        const store = selected()
        let reads = 0
        const content: SkillContentBinding['content'] = {
          ...store.content,
          async readMain(reference) {
            expect(this).toBe(content)
            expect(reference.contentVersion).toBe(1)
            reads += 1
            throw new Error('selected content read unavailable')
          },
        }
        const complete = Object.freeze({ ...store, content })
        const { app, appHome } = await scope.open({
          skillContent: representation === 'own' ? complete : inheritedBinding(complete),
        })
        const createdResponse = await app.request('/api/skills', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'root-read-failure', bodyMd: 'kept selected bytes' }),
        })
        expect(createdResponse.status).toBe(201)
        const created = (await createdResponse.json()) as { id: string }
        const response = await app.request(`/api/skills/${created.id}/content`, { headers })
        expect(response.status).toBe(500)
        expect(reads).toBe(1)
        expect(existsSync(join(appHome, 'skills', created.id))).toBe(false)
        expect(
          existsSync(
            join(store.rootReference, 'skills', created.id, 'versions', 'v1', 'files', 'SKILL.md'),
          ),
        ).toBe(true)
      }, 20_000)
    }
  },
)
