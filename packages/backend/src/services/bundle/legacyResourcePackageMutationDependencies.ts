// RFC-345 W4-C legacy writer composition.
//
// The module owns the typed adapter and its dependency port. Until the seven
// aggregate writers move, this service-side provider binds their existing
// implementations without introducing infrastructure -> services edges.

import {
  commitTemplateInTx,
  prepareTemplateFromBundle,
  type PreparedTemplateWrite,
} from '@/services/capabilityTemplates'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  type PreparedAgentCreate,
  type PreparedAgentUpdate,
} from '@/services/agent'
import {
  commitMcpCreateInTx,
  commitMcpUpdateInTx,
  getMcpById,
  prepareMcpCreate,
  type PreparedMcpCreate,
  type PreparedMcpUpdate,
} from '@/services/mcp'
import { commitPluginCreateInTx, commitPluginPublishInTx } from '@/services/plugin'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import { getAclResourceOwnerInTx, initialPrivateResourceAcl } from '@/services/resourceAcl'
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/services/skill'
import { unmarkSkillBootVerified } from '@/services/skillBootVerify'
import { finishOperation } from '@/services/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/services/skillVersion'
import {
  broadcastWorkflowCreated,
  commitWorkflowSaveInTx,
  insertWorkflowInTx,
  prepareWorkflowSave,
  rowToWorkflowDetail,
  type PreparedWorkflowSave,
} from '@/services/workflow'
import {
  broadcastWorkgroupCreated,
  commitWorkgroupCreateInTx,
  commitWorkgroupSaveInTx,
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  type PreparedWorkgroupCreate,
  type PreparedWorkgroupSave,
} from '@/services/workgroups'
import type { WorkgroupDetail } from '@agent-workflow/shared'
import type { workflows } from '@/db/schema'
import {
  createLegacyResourcePackageMutationAdapter,
  type LegacyResourcePackageMutationDependencies,
} from '@/modules/resource-catalog/public/operations'
import type { ResourcePackageMutationRuntime, ResourcePackageMutationRuntimeFactory } from './apply'

type WorkflowRow = typeof workflows.$inferSelect

export const legacyResourcePackageMutationDependencies = Object.freeze({
  prepareTemplateFromBundle: (db, payload, actor, existingId) =>
    prepareTemplateFromBundle(db, payload as never, actor, existingId),
  commitTemplateInTx: (tx, prepared) => commitTemplateInTx(tx, prepared as PreparedTemplateWrite),
  prepareAgentCreate,
  getAgentById,
  prepareAgentUpdate,
  commitAgentCreateInTx: (tx, prepared) =>
    commitAgentCreateInTx(tx, prepared as PreparedAgentCreate),
  commitAgentUpdateInTx: (tx, prepared) =>
    commitAgentUpdateInTx(tx, prepared as PreparedAgentUpdate),
  prepareMcpCreate: async (db, input, options, resourceId) => ({
    ...(await prepareMcpCreate(db, input, options)),
    id: resourceId,
  }),
  getMcpById,
  commitMcpCreateInTx: (tx, prepared) => commitMcpCreateInTx(tx, prepared as PreparedMcpCreate),
  commitMcpUpdateInTx: (tx, prepared) => commitMcpUpdateInTx(tx, prepared as PreparedMcpUpdate),
  commitPluginCreateInTx: (tx, input) => commitPluginCreateInTx(tx, input as never),
  commitPluginPublishInTx: (tx, captured, input) =>
    commitPluginPublishInTx(tx, captured as never, input as never),
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
  rowToWorkflowDetail: (row) => rowToWorkflowDetail(row as WorkflowRow),
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
