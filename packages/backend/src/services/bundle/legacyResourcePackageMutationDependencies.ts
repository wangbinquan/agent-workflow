// RFC-345 W4-C legacy writer composition.
//
// The module owns the typed adapter and its dependency port. Until the seven
// aggregate writers move, this service-side provider binds their existing
// implementations without introducing infrastructure -> services edges.

import { prepareTemplateFromBundle } from '@/services/capabilityTemplates'
import type { PreparedCapabilityTemplateWrite } from '@/modules/code-capability/application/ports/capabilityTemplatePersistence'
import { createSqliteCapabilityTemplatePersistence } from '@/modules/code-capability/infrastructure/sqliteCapabilityTemplatePersistence'
import { createSqliteCapabilityTemplatePackageCommitSync } from '@/modules/code-capability/infrastructure/capabilityTemplatePackageCommit'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  type PreparedAgentCreate,
  type PreparedAgentUpdate,
} from '@/modules/resource-catalog/infrastructure/legacy/agent'
import {
  commitLegacyMcpCreateInTx,
  commitLegacyMcpUpdateInTx,
  loadLegacyMcpById,
  prepareLegacyMcpCreate,
  type LegacyPreparedMcpCreate,
  type LegacyPreparedMcpUpdate,
} from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import {
  commitLegacyPluginCreateInTx,
  commitLegacyPluginPublishInTx,
  type LegacyPreparedPluginCreate,
  type PluginPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import { initialPrivateResourceAcl } from '@/modules/resource-catalog/application/resourceDefaults'
import { getAclResourceOwnerInTx } from '@/modules/resource-catalog/infrastructure/sqliteAclReadRepository'
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { unmarkSkillBootVerified } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { finishOperation } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  broadcastWorkflowCreated,
  commitWorkflowSaveInTx,
  insertWorkflowInTx,
  prepareWorkflowSave,
  rowToWorkflowDetail,
  type PreparedWorkflowSave,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import {
  broadcastWorkgroupCreated,
  commitWorkgroupCreateInTx,
  commitWorkgroupSaveInTx,
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  type PreparedWorkgroupCreate,
  type PreparedWorkgroupSave,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import type { WorkgroupDetail } from '@agent-workflow/shared'
import {
  createLegacyResourcePackageMutationAdapter,
  type LegacyResourcePackageMutationDependencies,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants'
import type { ResourcePackageMutationRuntime, ResourcePackageMutationRuntimeFactory } from './apply'

export const legacyResourcePackageMutationDependencies = Object.freeze({
  prepareTemplateFromBundle: (db, payload, actor, existingId) =>
    prepareTemplateFromBundle(
      createSqliteCapabilityTemplatePersistence(db),
      payload as never,
      actor,
      existingId,
    ),
  commitTemplateInTx: (tx, prepared) =>
    createSqliteCapabilityTemplatePackageCommitSync(tx).commit(
      prepared as PreparedCapabilityTemplateWrite,
    ),
  prepareAgentCreate,
  getAgentById,
  prepareAgentUpdate,
  commitAgentCreateInTx: (tx, prepared) =>
    commitAgentCreateInTx(tx, prepared as PreparedAgentCreate),
  commitAgentUpdateInTx: (tx, prepared) =>
    commitAgentUpdateInTx(tx, prepared as PreparedAgentUpdate),
  prepareMcpCreate: async (db, input, options, resourceId) => ({
    ...(await prepareLegacyMcpCreate(db, input, options)),
    id: resourceId,
  }),
  getMcpById: loadLegacyMcpById,
  commitMcpCreateInTx: (tx, prepared) =>
    commitLegacyMcpCreateInTx(tx, prepared as LegacyPreparedMcpCreate),
  commitMcpUpdateInTx: (tx, prepared) =>
    commitLegacyMcpUpdateInTx(tx, prepared as LegacyPreparedMcpUpdate),
  commitPluginCreateInTx: (tx, input) =>
    commitLegacyPluginCreateInTx(tx, input as LegacyPreparedPluginCreate),
  commitPluginPublishInTx: (tx, captured, input) =>
    commitLegacyPluginPublishInTx(tx, captured as PluginPersistenceRow, input as never),
  plannedGenerationDir,
  installPlugin: (pluginId, spec, options) => installPlugin(pluginId, spec, options),
  getAclResourceOwnerInTx,
  initialPrivateResourceAcl,
  assertRefsUsableInTx: (tx, actor, requests) => assertRefsUsableInTx(tx, actor, requests as never),
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
  stageManagedSkill: (db, options, input, produce) =>
    stageManagedSkill(db, options, input as never, produce),
  compensateManagedSkillStage,
  commitSkillReadyInTx,
  stageSkillVersion: (db, options, skillId, produce, commit) =>
    stageSkillVersion(db, options, skillId, produce, commit as never),
  abortStagedSkillVersion: (db, staged) =>
    abortStagedSkillVersion(db, staged as StagedSkillVersion),
  commitSkillVersionInTx: (tx, staged, commit) =>
    commitSkillVersionInTx(tx, staged as StagedSkillVersion, commit as never),
  publishStagedSkillVersion: (db, options, staged) =>
    publishStagedSkillVersion(db, options, staged as StagedSkillVersion),
  unmarkSkillBootVerified,
  finishOperation,
  prepareWorkflowSave: (db, id, input, principal) =>
    prepareWorkflowSave(db, id, input as never, principal),
  insertWorkflowInTx: (tx, input) => insertWorkflowInTx(tx, input as never),
  commitWorkflowSaveInTx: (tx, prepared) =>
    commitWorkflowSaveInTx(tx, prepared as PreparedWorkflowSave),
  rowToWorkflowDetail: (row) =>
    rowToWorkflowDetail(row as Parameters<typeof rowToWorkflowDetail>[0]),
  broadcastWorkflowCreated: (workflow) => broadcastWorkflowCreated(workflow as never),
  prepareWorkgroupCreate: async (db, input, options, resourceId) => ({
    ...(await prepareWorkgroupCreate(db, input, options as never)),
    groupId: resourceId,
  }),
  prepareWorkgroupSave: (db, id, input, principal) =>
    prepareWorkgroupSave(db, id, input as never, principal),
  commitWorkgroupCreateInTx: (tx, prepared) =>
    commitWorkgroupCreateInTx(tx, prepared as PreparedWorkgroupCreate),
  commitWorkgroupSaveInTx: (tx, prepared) =>
    commitWorkgroupSaveInTx(tx, prepared as PreparedWorkgroupSave),
  broadcastWorkgroupCreated: (workgroup) => broadcastWorkgroupCreated(workgroup as WorkgroupDetail),
} satisfies LegacyResourcePackageMutationDependencies)

/**
 * Compatibility composition for direct BundleApply tests and legacy service
 * callers. Both the default and the production module injection execute the
 * same seven typed participants; there is no parallel mutation path.
 */
const createLegacyResourcePackageMutationRuntime: ResourcePackageMutationRuntimeFactory['create'] =
  (input) => {
    const adapter = createLegacyResourcePackageMutationAdapter(
      {
        db: input.db,
        appHome: input.appHome,
        actor: input.actor,
        ...(input.pluginInstallOpts === undefined
          ? {}
          : { pluginInstallOpts: input.pluginInstallOpts }),
        ...(input.afterPluginInstall === undefined
          ? {}
          : { afterPluginInstall: input.afterPluginInstall }),
        ...(input.afterSkillStage === undefined ? {} : { afterSkillStage: input.afterSkillStage }),
      },
      legacyResourcePackageMutationDependencies,
    )
    const provider = adapter.createScenarioProvider({
      scenario: input.scenario,
      operations: input.operations,
      lowered: input.lowered,
      context: {
        pendingIds: input.pendingIds,
        pendingAgentNames: input.pendingAgentNames,
        key: input.key,
      },
    })
    const currentAuthority = () => {
      if (input.currentAuthority === undefined) {
        throw new Error('resource-package-current-authority-unavailable')
      }
      return input.currentAuthority()
    }
    const prestage: ResourcePackageMutationRuntime['prestage'] = (prepared, context) =>
      adapter.prestage(prepared, context)
    const assertUpdateTargetsOwnedInTx: ResourcePackageMutationRuntime['assertUpdateTargetsOwnedInTx'] =
      (tx, operations) => adapter.assertUpdateTargetsOwnedInTx(tx, operations)
    const bindApplyTx: ResourcePackageMutationRuntime['bindApplyTx'] = (tx, bundleCreatedNames) =>
      adapter.bindApplyTx(tx, { currentAuthority, bundleCreatedNames })
    const rollForwardCommitted: ResourcePackageMutationRuntime['rollForwardCommitted'] = (log) =>
      adapter.rollForwardCommitted(log)
    const runtime: ResourcePackageMutationRuntime = Object.freeze({
      provider,
      prestage,
      assertUpdateTargetsOwnedInTx,
      bindApplyTx,
      rollForwardCommitted,
      broadcastCommitted: () => adapter.broadcastCommitted(),
    })
    return runtime
  }

export const legacyResourcePackageMutationRuntimeFactory: ResourcePackageMutationRuntimeFactory =
  Object.freeze({ create: createLegacyResourcePackageMutationRuntime })
