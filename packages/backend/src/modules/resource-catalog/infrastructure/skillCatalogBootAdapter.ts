import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import { recoveryDirection } from './legacy/skillOpRecovery'
import { listActiveOps, type SkillOpPhase } from './legacy/skillOperations'
import { decodeSkillOperationIdentity } from './legacy/skillIdentityPaths'
import { skillRowPath } from './databaseSkillTrees'
import { ValidationError } from '@/util/errors'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillCatalogBootAdapter } from '../application/skills/skillCatalogBootParticipant'
import { activateBootReverify, runBootSnapshotReverify } from './legacy/skillBootVerify'
import { recoverSkillOperations } from './legacy/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from './legacy/skillOpRegistry'
import type {
  SkillLifecycleContentStore,
  SkillSnapshotInspector,
} from '../application/skills/lifecycleContentStore'
import type { SkillDeletionContentStore } from '../application/skills/deletionContentStore'
import type { SkillVersionRecoveryContentStore } from '../application/skills/versionRecoveryContentStore'
import type { SkillIdentityContentStore } from '../application/skills/identityContentStore'
import type { SkillIdentityInspector } from '../application/skills/identityInspector'
import type { SkillCreationContentStore } from '../application/skills/creationContentStore'
import { createFileSkillVersionRecoveryContentStore } from './local/fileSkillVersionRecoveryContentStore'
import { createFileSkillIdentityContentStore } from './local/fileSkillIdentityContentStore'
import { createFileSkillIdentityInspector } from './local/fileSkillIdentityInspector'
import { createFileSkillLifecycleContentStore } from './local/fileSkillLifecycleContentStore'
import { createFileSkillSnapshotInspector } from './local/fileSkillSnapshotInspector'
import { createFileSkillDeletionContentStore } from './local/fileSkillDeletionContentStore'
import { reconcileSkillLiveFiles } from './legacy/skillVersion'

/** RFC-359 W4-D23c：崩溃安全的启动状态机，一份适配器两个数据库共用。 */
export function createSkillCatalogBootAdapter(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly lifecycleContent?: SkillLifecycleContentStore
  readonly snapshotInspector?: SkillSnapshotInspector
  readonly deletionContent?: SkillDeletionContentStore
  readonly creationContent?: SkillCreationContentStore
  readonly versionRecovery?: SkillVersionRecoveryContentStore
  readonly identityContent?: SkillIdentityContentStore
  readonly identityInspector?: SkillIdentityInspector
}): SkillCatalogBootAdapter {
  const selected = {
    ...input,
    identityContent: input.identityContent ?? createFileSkillIdentityContentStore(input.appHome),
    identityInspector: input.identityInspector ?? createFileSkillIdentityInspector(input.appHome),
    lifecycleContent:
      input.lifecycleContent ?? createFileSkillLifecycleContentStore(input.appHome, input.db),
    snapshotInspector:
      input.snapshotInspector ?? createFileSkillSnapshotInspector(input.appHome, input.db),
    deletionContent:
      input.deletionContent ?? createFileSkillDeletionContentStore(input.appHome, input.db),
    versionRecovery:
      input.versionRecovery ?? createFileSkillVersionRecoveryContentStore(input.appHome),
  }
  return Object.freeze({
    recoverOperations: async () => {
      await assertNativeRecoveryAuthority(input.db, selected.identityInspector)
      return Object.freeze(
        await recoverSkillOperations(input.db, selected, SKILL_OP_RECOVERY_REGISTRY),
      )
    },
    activateAvailabilityGate: () => activateBootReverify(),
    reconcileLiveFiles: async () => await reconcileSkillLiveFiles(input.db, selected),
    reverifySnapshots: async () => Object.freeze(await runBootSnapshotReverify(input.db, selected)),
  })
}

/** Normal recovery keeps the storage/row proofs previously run by the upgrade
 * barrier. Epoch-1 migration intents must already have settled before conversion. */
async function assertNativeRecoveryAuthority(
  db: PersistenceDb,
  inspector: SkillIdentityInspector,
): Promise<void> {
  const { skills, skillVersions } = tablesOf(db)
  for (const op of await listActiveOps(db)) {
    if (op.kind === 'migrate') throw new Error('skill-legacy-upgrade-requires-conversion')
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    if (identity.legacyName !== undefined)
      throw new Error('skill-legacy-upgrade-requires-conversion')
    const direction = recoveryDirection(op.kind, op.phase as SkillOpPhase)
    if (direction !== 'rollback' && direction !== 'rollforward') continue
    const invalid = (message: string): never => {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `${op.kind} operation ${op.opId} ${message}`,
      )
    }
    const [row] = await db.select().from(skills).where(eq(skills.id, op.skillId)).limit(1)
    if (op.kind === 'delete' && direction === 'rollforward') {
      if (row || op.backupPath === null) invalid('disagrees with committed deletion authority')
      await inspector.assertCommittedDelete({
        skillId: op.skillId,
        operationId: op.opId,
        backupReference: op.backupPath!,
      })
      continue
    }
    if (!row) invalid('has no matching skills row')
    if (skillRowPath(row!, op.skillId, 'live') === null)
      invalid('payload does not match its DB path generation')
    const versions = await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
    for (const version of versions)
      if (skillRowPath(version, op.skillId, `version:${version.versionIndex}`) === null)
        invalid('payload does not match its DB path generation')
    if (op.kind === 'reserve') {
      if (row!.reservationState !== (direction === 'rollback' ? 'reserving' : 'ready'))
        invalid('disagrees with reservation state')
      const hasNoVersion = versions.length === 0 && row!.contentVersion === 0
      const hasExactlyV1 =
        versions.length === 1 && versions[0]?.versionIndex === 1 && row!.contentVersion === 1
      // The nested v1 commit may finish before reserve advances fs-staged.
      const validVersions =
        op.phase === 'intent'
          ? hasNoVersion
          : op.phase === 'fs-staged'
            ? hasNoVersion || hasExactlyV1
            : hasExactlyV1
      if (!validVersions) invalid('disagrees with v1 publication authority')
      if (direction === 'rollforward' && row!.versionState !== 'snapshot-authoritative')
        invalid('has incomplete published row authority')
      if (op.phase === 'fs-published' || direction === 'rollforward') {
        const version = versions[0]
        if (
          versions.length !== 1 ||
          version?.versionIndex !== 1 ||
          version.contentHash === null ||
          row!.contentVersion !== 1
        )
          invalid('has no complete published v1 tree')
        await inspector.assertPublishedReserve({
          skillId: op.skillId,
          operationId: op.opId,
          contentHash: version!.contentHash!,
        })
      }
    } else if (op.kind === 'version-write') {
      const max = versions.reduce((value, version) => Math.max(value, version.versionIndex), 0)
      const target = versions.find((version) => version.versionIndex === op.targetVersion)
      if (op.targetVersion === null || op.targetVersion < 1) invalid('has no valid target version')
      if (
        (direction === 'rollback' ? target !== undefined : target === undefined) ||
        row!.reservationState !== 'ready' ||
        row!.contentVersion !== max ||
        op.targetVersion !== (direction === 'rollback' ? max + 1 : max)
      )
        invalid('disagrees with version authority')
    } else if (row!.reservationState !== 'ready') invalid('does not target a ready skill')
  }
}
