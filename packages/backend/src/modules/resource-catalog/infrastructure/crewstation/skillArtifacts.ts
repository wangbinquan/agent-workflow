import { and, eq } from 'drizzle-orm'
import { BundleSkillPayloadSchema, IntentSkillPayloadSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { skills, skillVersions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  IntentSkillArtifactOwner,
  IntentSkillPublication,
} from '../../application/intent/artifactOwners'
import type {
  ResourcePackageArtifactContext,
  ResourcePackageSkillArtifact,
  ResourcePackageSkillArtifactOwner,
} from '../../application/package/artifactOwners'
import { renderResourcePackageSkillMarkdown } from '../resourcePackageSkillDocument'
import { skillFilesRel, skillVersionRelPath } from '../legacy/skillIdentityPaths'
import { markSkillBootVerified } from '../legacy/skillBootVerify'
import { resourcePackageSkillRecoveryDisposition } from '../../domain/resourcePackageSkillRecovery'
import {
  LIVE_TREE,
  deleteTree,
  hashSkillTree,
  normalizeSkillPath,
  readTree,
  stagingTree,
  treeExists,
  versionTree,
  writeTree,
  type SkillTreeFile,
} from '../databaseSkillTrees'

interface SkillStage {
  readonly skillId: string
  readonly operationId: string
  readonly version: number
}
const stageReference = (stage: SkillStage) =>
  `${skillFilesRel(stage.skillId)}.op-${stage.operationId}.staged`
function assertStage(stage: SkillStage) {
  if (
    ![stage.skillId, stage.operationId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)) ||
    !Number.isSafeInteger(stage.version) ||
    stage.version < 1
  )
    throw new Error('hosted-skill-stage-identity-invalid')
}

/** Resource Catalog owns staged/version/live trees for both Intent and package
 * mutations. All recovery state is durable; a new receiver needs no plan map. */
export function createDatabaseSkillArtifactOwners(
  db: ProviderNeutralDatabase,
  fence?: CrewStationMutationFence,
) {
  const transaction = databaseSessionFor(db)
  const write = <T>(run: (tx: ProviderNeutralDatabase) => Promise<T>) => {
    const lease = fence?.current()
    return transaction.transaction(async (tx) => {
      if (fence && lease) await fence.assertHeld(tx, lease)
      return run(tx)
    })
  }
  const checkStage = async (
    handle: Parameters<typeof readTree>[0],
    stage: SkillStage,
    expected: string,
  ) => {
    const files = await readTree(handle, stage.skillId, stagingTree(stage.operationId))
    if (files.length === 0 || hashSkillTree(files) !== expected)
      throw new Error('hosted-skill-stage-hash-mismatch')
    return files
  }
  const stage = async (identity: SkillStage, files: readonly SkillTreeFile[]) => {
    assertStage(identity)
    return write(async (tx) => {
      const baseline =
        identity.version === 1
          ? []
          : await readTree(tx, identity.skillId, versionTree(identity.version - 1))
      if (identity.version > 1 && baseline.length === 0)
        throw new Error('hosted-skill-baseline-missing')
      const tree = new Map(baseline.map((file) => [file.path, file.bytes]))
      for (const file of files) tree.set(normalizeSkillPath(file.path), file.bytes)
      const candidate = [...tree].map(([path, bytes]) => ({ path, bytes }))
      const digest = hashSkillTree(candidate)
      const staging = stagingTree(identity.operationId)
      if (await treeExists(tx, identity.skillId, staging)) await checkStage(tx, identity, digest)
      else await writeTree(tx, identity.skillId, staging, candidate, Date.now())
      return {
        managedPath: skillFilesRel(identity.skillId),
        filesPath: skillVersionRelPath(identity.skillId, identity.version),
        contentHash: digest,
      }
    })
  }
  const publish = async (identity: SkillStage) => {
    assertStage(identity)
    const current = await write(async (tx) => {
      const skill = (
        await tx.select().from(skills).where(eq(skills.id, identity.skillId)).limit(1)
      )[0]
      const version = (
        await tx
          .select()
          .from(skillVersions)
          .where(
            and(
              eq(skillVersions.skillId, identity.skillId),
              eq(skillVersions.versionIndex, identity.version),
            ),
          )
          .limit(1)
      )[0]
      if (
        !skill ||
        skill.contentVersion < identity.version ||
        !version?.contentHash ||
        skill.managedPath !== skillFilesRel(identity.skillId) ||
        version.filesPath !== skillVersionRelPath(identity.skillId, identity.version)
      )
        throw new Error('hosted-skill-publication-metadata-mismatch')
      const target = versionTree(identity.version)
      let files = await readTree(tx, identity.skillId, target)
      if (files.length === 0) {
        files = await checkStage(tx, identity, version.contentHash)
        await writeTree(tx, identity.skillId, target, files, Date.now())
      } else if (hashSkillTree(files) !== version.contentHash)
        throw new Error('hosted-skill-version-hash-mismatch')
      if (skill.contentVersion === identity.version)
        await writeTree(tx, identity.skillId, LIVE_TREE, files, Date.now())
      await deleteTree(tx, identity.skillId, stagingTree(identity.operationId))
      return skill.contentVersion === identity.version
    })
    if (current) markSkillBootVerified(identity.skillId)
  }
  const discard = async (identity: SkillStage) => {
    assertStage(identity)
    await write((tx) => deleteTree(tx, identity.skillId, stagingTree(identity.operationId)))
  }
  const intentPlan = (
    identity: SkillStage,
    payloadInput: Parameters<IntentSkillArtifactOwner['planCreate']>[0]['payload'],
  ) => {
    assertStage(identity)
    const payload = IntentSkillPayloadSchema.parse(payloadInput)
    const artifact =
      identity.version === 1
        ? {
            kind: 'skill-stage' as const,
            skillId: identity.skillId,
            operationId: identity.operationId,
            stagingDirectory: stageReference(identity),
          }
        : {
            kind: 'skill-version-stage' as const,
            skillId: identity.skillId,
            operationId: identity.operationId,
            version: identity.version,
            stagingDirectory: stageReference(identity),
            versionDirectory: skillVersionRelPath(identity.skillId, identity.version),
          }
    return {
      artifact,
      async stage() {
        const publication = await stage(identity, [
          { path: 'SKILL.md', bytes: Buffer.from(renderResourcePackageSkillMarkdown(payload)) },
          ...payload.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.content) })),
        ])
        return {
          ...publication,
          async commitInTransaction(
            tx: Parameters<IntentSkillPublication['commitInTransaction']>[0],
            versionIndex: number,
          ) {
            if (fence) await fence.assertHeld(tx, fence.current())
            if (versionIndex !== identity.version) throw new Error('hosted-skill-version-mismatch')
            await checkStage(tx, identity, publication.contentHash)
          },
        }
      },
      compensate: () => discard(identity),
      rollForward: () => publish(identity),
      complete: () => publish(identity),
    }
  }
  const intent: IntentSkillArtifactOwner = {
    planCreate: async (request) =>
      intentPlan(
        { skillId: request.skillId, operationId: request.operationId, version: 1 },
        request.payload,
      ),
    planUpdate: async (request) =>
      intentPlan(
        {
          skillId: request.current.id,
          operationId: request.operationId,
          version: request.current.contentVersion + 1,
        },
        request.payload,
      ),
  }
  const stages = new WeakMap<ResourcePackageArtifactContext, Map<string, SkillStage>>()
  const packagePlan = (
    context: ResourcePackageArtifactContext,
    identity: SkillStage,
    artifact: ResourcePackageSkillArtifact,
    payloadInput: unknown,
  ) => {
    assertStage(identity)
    const payload = BundleSkillPayloadSchema.parse(payloadInput)
    let plans = stages.get(context)
    if (!plans) {
      plans = new Map()
      stages.set(context, plans)
    }
    if (plans.has(identity.operationId)) throw new Error('hosted-skill-operation-duplicate')
    plans.set(identity.operationId, identity)
    return {
      artifact,
      async stage() {
        const read = context.readSkillFile
        if (!read) throw new Error('resource-package-skill-file-reader-missing')
        const files: SkillTreeFile[] = [
          { path: 'SKILL.md', bytes: Buffer.from(renderResourcePackageSkillMarkdown(payload)) },
        ]
        for (const file of payload.files) {
          if (normalizeSkillPath(file.path).toLowerCase() === 'skill.md')
            throw new Error('resource-package-skill-main-file-protected')
          files.push({ path: file.path, bytes: read(file.ref) })
        }
        return stage(identity, files)
      },
    }
  }
  const identityOf = (artifact: ResourcePackageSkillArtifact): SkillStage => {
    const identity = {
      skillId: artifact.skillId,
      operationId: artifact.operationId,
      version: artifact.kind === 'skill-stage' ? 1 : artifact.version,
    }
    assertStage(identity)
    if (
      artifact.stagingDirectory !== stageReference(identity) ||
      (artifact.kind === 'skill-stage'
        ? artifact.targetDirectory !== skillFilesRel(identity.skillId)
        : artifact.versionDirectory !== skillVersionRelPath(identity.skillId, identity.version))
    )
      throw new Error('hosted-skill-artifact-reference-mismatch')
    return identity
  }
  const packages: ResourcePackageSkillArtifactOwner = {
    planCreate(context, request) {
      const identity = { skillId: request.skillId, operationId: request.mutation.opId, version: 1 }
      return packagePlan(
        context,
        identity,
        {
          kind: 'skill-stage',
          skillId: identity.skillId,
          operationId: identity.operationId,
          stagingDirectory: stageReference(identity),
          targetDirectory: skillFilesRel(identity.skillId),
        },
        request.mutation.payload,
      )
    },
    planUpdate(context, request) {
      const identity = {
        skillId: request.skillId,
        operationId: request.mutation.opId,
        version: request.version,
      }
      return packagePlan(
        context,
        identity,
        {
          kind: 'skill-version-stage',
          ...identity,
          publishId: request.publishId,
          stagingDirectory: stageReference(identity),
          versionDirectory: skillVersionRelPath(identity.skillId, identity.version),
        },
        request.mutation.payload,
      )
    },
    async compensate(context, request) {
      const identity = identityOf(request.artifact)
      if (request.databaseCommitted) await publishPackage(request.artifact)
      else await discard(identity)
      stages.get(context)?.delete(request.artifact.operationId)
    },
    async rollForward(context, request) {
      if (
        !request.receipt.applied.some(
          (entry) =>
            entry.operationId === request.artifact.operationId &&
            entry.resourceId === request.artifact.skillId &&
            entry.resourceType === 'skill',
        )
      )
        throw new Error('resource-package-artifact-receipt-missing')
      await publishPackage(request.artifact)
      stages.get(context)?.delete(request.artifact.operationId)
    },
    async afterCommitted(context) {
      if ((stages.get(context)?.size ?? 0) > 0)
        throw new Error('resource-package-skill-roll-forward-incomplete')
      stages.delete(context)
    },
  }
  async function publishPackage(artifact: ResourcePackageSkillArtifact) {
    const identity = identityOf(artifact)
    const current = (
      await db
        .select({ version: skills.contentVersion })
        .from(skills)
        .where(eq(skills.id, identity.skillId))
        .limit(1)
    )[0]
    const disposition = resourcePackageSkillRecoveryDisposition({
      currentContentVersion: current?.version ?? null,
      artifactVersion: identity.version,
    })
    if (disposition === 'cleanup-deleted' || disposition === 'cleanup-superseded')
      return discard(identity)
    if (disposition === 'reject-missing-generation')
      throw new Error('resource-package-skill-publication-missing')
    await publish(identity)
  }
  return {
    intent,
    packages,
    recovery: {
      publish,
      discard,
      stageReference,
      publishArtifact: publishPackage,
      discardArtifact: (artifact: ResourcePackageSkillArtifact) => discard(identityOf(artifact)),
    },
  }
}
