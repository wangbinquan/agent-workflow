// RFC-432: the ten selections whose standalone value needs the session graph are factories both profiles state.
// The standalone value is the module's own local constructor (the profile builds nothing before the startup
// lock), and every session calls it with its own database — so a session recomposed on another database after a
// SQLite → PostgreSQL move builds its own instances there. The behaviour case runs on two real databases of the
// selected provider (`databaseCount: 2`), so both engines carry it.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standaloneSelections } from '@/bootstrap/standalone'
import { createLocalRuntimeContent } from '@/bootstrap/contentRuntime'
import { createLocalReviewArtifacts } from '@/modules/collaboration/composition/contentArtifacts'
import { createFileResourcePackageSkillArtifactOwner } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { composeLocalIntentArtifacts } from '@/modules/intent/composition/apply'
import { createPostgresqlAdminBackupCoordinator } from '@/modules/system-operations/composition'
import { createRepositoryPublicationTransport } from '@/modules/source-control/composition'
import {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '@/modules/source-control/composition/repositoryPreparation'
import type { ContentPutRequest } from '@/platform/content/contentStore'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createDevelopmentWorkspaceRepositoryPreparation } from '@/modules/source-control/infrastructure/local/developmentWorkspaceRepositoryPreparation'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { SESSION_FACTORY_SELECTIONS } from './helpers/deploymentSelectionPartition'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc432-session-factories-'))
  roots.push(root)
  return root
}

/** A shared reference always goes through the content catalog, so the write leaves a row in the store's database. */
function sharedPut(text: string): ContentPutRequest {
  const bytes = new TextEncoder().encode(text)
  return {
    publication: {
      owner: 'rfc432-session-factories',
      logicalKey: text,
      scope: 'scope',
      attempt: text,
      epoch: 1,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
    },
    source: { kind: 'bytes', bytes },
    contentVersion: 1,
    mediaType: 'text/plain',
    references: 'shared',
  }
}

async function catalogRows(db: PersistenceDb): Promise<number> {
  return (await db.select().from(tablesOf(db).contentObjects)).length
}

test('the standalone profile states every session-scoped selection as a function', () => {
  const selections = standaloneSelections({ appHome: home() })
  for (const key of SESSION_FACTORY_SELECTIONS) expect(typeof selections[key]).toBe('function')
})

test('the standalone session factories are the modules’ own local constructors', () => {
  const selections = standaloneSelections({ appHome: home() })
  expect(selections.reviewArtifacts).toBe(createLocalReviewArtifacts)
  expect(selections.resourcePackageSkillArtifacts).toBe(createFileResourcePackageSkillArtifactOwner)
  expect(selections.intentArtifacts).toBe(composeLocalIntentArtifacts)
  expect(selections.databaseBackup).toBe(createPostgresqlAdminBackupCoordinator)
  expect(selections.repositoryPublicationTransport).toBe(createRepositoryPublicationTransport)
  expect(selections.developmentWorkspaceRepositoryPreparation).toBe(
    createDevelopmentWorkspaceRepositoryPreparation,
  )
  expect(selections.repositoryPreparationEffects).toBe(composeLocalRepositoryPreparationEffects)
  expect(selections.scratchWorkspaceEffects).toBe(composeLocalScratchWorkspaceEffects)
})

test('building the profile calls no session factory: nothing appears under the app home', () => {
  const appHome = home()
  standaloneSelections({ appHome })
  expect(readdirSync(appHome)).toEqual([])
})

describeEachProvider(
  'RFC-432 standalone session factories',
  (harness) => {
    test('each session builds its own instances, and content lands in its own database', async () => {
      const appHome = home()
      const selections = standaloneSelections({ appHome })
      const first = { db: harness.database(0).db, appHome }
      const second = { db: harness.database(1).db, appHome }

      const firstContent = selections.contentStore(first)
      const secondContent = selections.contentStore(second)
      expect(firstContent).not.toBe(secondContent)
      expect(Object.keys(firstContent).sort()).toEqual(
        Object.keys(createLocalRuntimeContent(first.db, appHome)).sort(),
      )
      const before = [await catalogRows(first.db), await catalogRows(second.db)] as const
      const firstRef = await firstContent.put(sharedPut('rfc432 first session'), async () => {})
      expect(await catalogRows(first.db)).toBe(before[0] + 1)
      expect(await catalogRows(second.db)).toBe(before[1])
      const secondRef = await secondContent.put(sharedPut('rfc432 second session'), async () => {})
      expect(await catalogRows(first.db)).toBe(before[0] + 1)
      expect(await catalogRows(second.db)).toBe(before[1] + 1)
      expect(new TextDecoder().decode(await firstContent.read(firstRef))).toBe(
        'rfc432 first session',
      )
      expect(new TextDecoder().decode(await secondContent.read(secondRef))).toBe(
        'rfc432 second session',
      )

      expect(selections.skillContent(first)).not.toBe(selections.skillContent(second))
      expect(selections.resourcePackageSkillArtifacts(first)).not.toBe(
        selections.resourcePackageSkillArtifacts(second),
      )
      const firstIntent = selections.intentArtifacts(first)
      const secondIntent = selections.intentArtifacts(second)
      expect(firstIntent.skillArtifacts).not.toBe(secondIntent.skillArtifacts)
      expect(Object.keys(firstIntent).sort()).toEqual([
        'artifactContent',
        'pluginArtifacts',
        'skillArtifacts',
      ])
      // The review owner is built per session from the content store that session selected.
      const firstReview = selections.reviewArtifacts({ ...first, content: firstContent })
      const secondReview = selections.reviewArtifacts({ ...second, content: secondContent })
      expect(firstReview).not.toBe(secondReview)
      expect(firstReview.store).not.toBe(secondReview.store)
      expect(Object.keys(firstReview).sort()).toEqual(['content', 'store'])
    })
  },
  { databaseCount: 2 },
)
