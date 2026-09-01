// RFC-345 T4b — service-side bindings for the resource-catalog Intent adapter.
//
// This is the only Intent compatibility file that imports the six legacy aggregate writers.
// The module-owned adapter depends on its structural port and never imports services in reverse.

import type { WorkgroupDetail } from '@agent-workflow/shared'
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
  loadLegacyPluginRow,
  pluginConfigHash,
  pluginFromPersistenceRow,
  type LegacyPreparedPluginCreate,
  type LegacyPluginPublishSet,
  type PluginPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { finishOperation } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { unmarkSkillBootVerified } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
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
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import {
  loadLegacyIntentResourceRevisionInTx,
  loadLegacyIntentSkillOperationState,
  type LegacyIntentApplyResourceDependencies,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'

const intentResourceDependencies = {
  prepareAgentCreate,
  getAgentById,
  prepareAgentUpdate,
  commitAgentCreateInTx: (tx, prepared) =>
    commitAgentCreateInTx(tx, prepared as PreparedAgentCreate),
  commitAgentUpdateInTx: (tx, prepared) =>
    commitAgentUpdateInTx(tx, prepared as PreparedAgentUpdate),
  prepareMcpCreate: prepareLegacyMcpCreate,
  getMcpById: async (db, id) => {
    const row = await loadLegacyMcpById(db, id)
    return row === null ? null : { ...row, ownerUserId: row.ownerUserId ?? null }
  },
  commitMcpCreateInTx: (tx, prepared) =>
    commitLegacyMcpCreateInTx(tx, prepared as LegacyPreparedMcpCreate),
  commitMcpUpdateInTx: (tx, prepared) =>
    commitLegacyMcpUpdateInTx(tx, prepared as LegacyPreparedMcpUpdate),
  getPluginById: loadLegacyPluginRow,
  pluginOperationConfigHashOf: (row) => pluginConfigHash(pluginFromPersistenceRow(row)),
  commitPluginCreateInTx: (tx, input): void => {
    void commitLegacyPluginCreateInTx(tx, input as LegacyPreparedPluginCreate)
  },
  commitPluginPublishInTx: (tx, captured, input) =>
    commitLegacyPluginPublishInTx(
      tx,
      captured as PluginPersistenceRow,
      input as LegacyPluginPublishSet,
    ),
  plannedGenerationDir,
  installPlugin,
  stageManagedSkill,
  stageSkillVersion,
  commitSkillReadyInTx,
  commitSkillVersionInTx: (tx, staged, commit) => {
    void commitSkillVersionInTx(tx, staged as StagedSkillVersion, commit)
  },
  prepareWorkflowSave,
  insertWorkflowInTx,
  commitWorkflowSaveInTx: (tx, prepared) =>
    commitWorkflowSaveInTx(tx, prepared as PreparedWorkflowSave),
  broadcastWorkflowCreated: (row) =>
    broadcastWorkflowCreated(rowToWorkflowDetail(row as Parameters<typeof rowToWorkflowDetail>[0])),
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  commitWorkgroupCreateInTx: (tx, prepared) =>
    commitWorkgroupCreateInTx(tx, prepared as PreparedWorkgroupCreate),
  commitWorkgroupSaveInTx: (tx, prepared) =>
    commitWorkgroupSaveInTx(tx, prepared as PreparedWorkgroupSave),
  broadcastWorkgroupCreated: (row) => broadcastWorkgroupCreated(row as WorkgroupDetail),
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
  resourceRevisionInTx: loadLegacyIntentResourceRevisionInTx,
} satisfies LegacyIntentApplyResourceDependencies

export const legacyIntentApplyResourceDependencies = Object.freeze({
  ...intentResourceDependencies,
  skillOperationState: loadLegacyIntentSkillOperationState,

  // Intent-owned convergence calls these exact legacy effects without reaching
  // back into the six writer modules from applyChangeset.ts.
  compensateManagedSkillStage,
  abortStagedSkillVersion,
  publishStagedSkillVersion,
  unmarkSkillBootVerified,
  finishOperation,
})
