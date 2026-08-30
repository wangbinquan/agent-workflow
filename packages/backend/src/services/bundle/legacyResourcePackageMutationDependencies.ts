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
import type { LegacyResourcePackageMutationDependencies } from '@/modules/resource-catalog/public/operations'

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
