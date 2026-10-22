import { tablesOf } from '@/platform/persistence/sessionTables'
import { BundlePluginPayloadSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntentPluginArtifactOwner } from '../../application/intent/artifactOwners'
import type {
  ResourcePackageArtifactContext,
  ResourcePackagePluginArtifact,
  ResourcePackagePluginArtifactOwner,
} from '../../application/package/artifactOwners'
import type { createHostedPluginGenerations } from './pluginGenerations'

export function createHostedPluginArtifactOwners(input: {
  readonly db: PersistenceDb
  readonly generations: ReturnType<typeof createHostedPluginGenerations>
}) {
  const store = input.generations
  const verifyCurrent = async (pluginId: string, allowDeleted = false) => {
    const { plugins } = tablesOf(input.db)
    const current = (
      await input.db
        .select({ cachedPath: plugins.cachedPath })
        .from(plugins)
        .where(eq(plugins.id, pluginId))
        .limit(1)
    )[0]
    if (!current) {
      if (allowDeleted) return
      throw new Error('hosted-plugin-publication-missing')
    }
    const manifest = await store.read(current.cachedPath)
    if (manifest.pluginId !== pluginId) throw new Error('hosted-plugin-publication-owner-mismatch')
  }
  const intent: IntentPluginArtifactOwner = {
    async planInstall(request) {
      const generationId = ulid()
      const generationDir = store.generationReference(request.pluginId, generationId)
      return {
        artifact: {
          kind: 'plugin-install',
          pluginId: request.pluginId,
          generationId,
          generationDir,
        },
        stage: () => store.installGeneration(request.pluginId, request.spec, generationId),
        compensate: () => store.discard(generationDir),
        rollForward: () => verifyCurrent(request.pluginId),
        complete: () => verifyCurrent(request.pluginId),
      }
    },
  }
  const plans = new WeakMap<ResourcePackageArtifactContext, Set<string>>()
  const assertReference = (artifact: ResourcePackagePluginArtifact) => {
    if (
      artifact.generationDirectory !==
      store.generationReference(artifact.pluginId, artifact.generationId)
    )
      throw new Error('hosted-plugin-artifact-reference-mismatch')
  }
  const packages: ResourcePackagePluginArtifactOwner = {
    planInstall(context, request) {
      const payload = BundlePluginPayloadSchema.parse(request.mutation.payload)
      const generationDirectory = store.generationReference(request.pluginId, request.generationId)
      const artifact: ResourcePackagePluginArtifact = {
        kind: 'plugin-install',
        operationId: request.mutation.opId,
        pluginId: request.pluginId,
        generationId: request.generationId,
        generationDirectory,
      }
      let pending = plans.get(context)
      if (!pending) {
        pending = new Set()
        plans.set(context, pending)
      }
      if (pending.has(artifact.operationId))
        throw new Error('resource-package-plugin-operation-duplicate')
      pending.add(artifact.operationId)
      return {
        artifact,
        install: () =>
          store.installGeneration(request.pluginId, payload.spec, request.generationId),
      }
    },
    async compensate(context, request) {
      assertReference(request.artifact)
      if (request.databaseCommitted) await verifyCurrent(request.artifact.pluginId, true)
      else await store.discard(request.artifact.generationDirectory)
      plans.get(context)?.delete(request.artifact.operationId)
    },
    async rollForward(context, request) {
      assertReference(request.artifact)
      if (
        !request.receipt.applied.some(
          (entry) =>
            entry.operationId === request.artifact.operationId &&
            entry.resourceType === 'plugin' &&
            entry.resourceId === request.artifact.pluginId,
        )
      )
        throw new Error('resource-package-artifact-receipt-missing')
      await verifyCurrent(request.artifact.pluginId, true)
      plans.get(context)?.delete(request.artifact.operationId)
    },
    async afterCommitted(context) {
      if (plans.get(context)?.size)
        throw new Error('resource-package-plugin-roll-forward-incomplete')
      plans.delete(context)
    },
  }
  return { intent, packages, recovery: { verifyCurrent, assertReference } }
}
