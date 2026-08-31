// RFC-345 T4b — service-side bindings for the resource-catalog Intent adapter.
//
// This is the only Intent compatibility file that imports the six legacy aggregate writers.
// The module-owned adapter depends on its structural port and never imports services in reverse.

import { eq } from 'drizzle-orm'
import type {
  UpdateWorkflow,
  UpdateWorkgroup,
  WorkflowDefinition,
  WorkgroupDetail,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { agents, mcps, plugins, skillOperations, skills, workflows, workgroups } from '@/db/schema'
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
  rowToMcp,
  type PreparedMcpCreate,
  type PreparedMcpUpdate,
} from '@/services/mcp'
import { commitPluginCreateInTx, commitPluginPublishInTx, rowToPlugin } from '@/services/plugin'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/services/skill'
import { finishOperation } from '@/services/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/services/skillVersion'
import { unmarkSkillBootVerified } from '@/services/skillBootVerify'
import { encodeSkillToken } from '@/services/skillToken'
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
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import { NotFoundError } from '@/util/errors'
import type { ResourceSummaryRevision } from '@/modules/resource-catalog/public/types'
import type { CatalogSelectorKind } from '@/modules/resource-catalog/public/types'

type PluginRow = typeof plugins.$inferSelect
type WorkflowRow = typeof workflows.$inferSelect

interface IntentPluginSnapshot {
  readonly id: string
  readonly name: string
  readonly spec: string
  readonly optionsJson: string
  readonly description: string
  readonly enabled: boolean
  readonly sourceKind: 'npm' | 'git' | 'file'
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly installedAt: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface IntentPreparedPluginCreate {
  readonly id: string
  readonly parsed: {
    readonly name: string
    readonly spec: string
    readonly options: Readonly<Record<string, unknown>>
    readonly description: string
    readonly enabled: boolean
  }
  readonly initialAcl: {
    readonly ownerUserId: string
    readonly visibility: 'private'
    readonly aclRevision: 0
  }
  readonly install: {
    readonly generationDir: string | null
    readonly sourceKind: 'npm' | 'git' | 'file'
    readonly cachedPath: string
    readonly resolvedVersion: string | null
    readonly sourceIdentity: string | null
    readonly manifest: Readonly<{
      readonly version: 1
      readonly pluginId: string
      readonly opId: string
      readonly sourceKind: 'npm' | 'git'
      readonly requestedSpec: string
      readonly entryRelativePath: string
      readonly resolvedVersion: string | null
      readonly sourceIdentity: string
      readonly resolved: string
      readonly integrity: string | null
      readonly commit: string | null
      readonly completed: true
      readonly createdAt: number
    }> | null
  }
  readonly now: number
}

async function getIntentPluginRow(db: DbClient, id: string): Promise<PluginRow | null> {
  return (await db.select().from(plugins).where(eq(plugins.id, id)).limit(1))[0] ?? null
}

function requireRevisionRow<T>(row: T | undefined, kind: CatalogSelectorKind): T {
  if (row === undefined) throw new NotFoundError(`${kind}-not-found`, `${kind} not found`)
  return row
}

function resourceRevisionInTx<K extends CatalogSelectorKind>(
  tx: DbTxSync,
  kind: K,
  resourceId: string,
): ResourceSummaryRevision<K> {
  switch (kind) {
    case 'agent': {
      const row = requireRevisionRow(
        tx
          .select({ updatedAt: agents.updatedAt, aclRevision: agents.aclRevision })
          .from(agents)
          .where(eq(agents.id, resourceId))
          .get(),
        kind,
      )
      return {
        kind,
        updatedAt: row.updatedAt,
        aclRevision: row.aclRevision,
      } as ResourceSummaryRevision<K>
    }
    case 'skill': {
      const row = requireRevisionRow(
        tx
          .select({ contentVersion: skills.contentVersion, metaRevision: skills.metaRevision })
          .from(skills)
          .where(eq(skills.id, resourceId))
          .get(),
        kind,
      )
      return {
        kind,
        token: encodeSkillToken({
          skillId: resourceId,
          contentVersion: row.contentVersion,
          metaRevision: row.metaRevision,
        }),
      } as ResourceSummaryRevision<K>
    }
    case 'mcp': {
      const row = requireRevisionRow(
        tx.select().from(mcps).where(eq(mcps.id, resourceId)).get(),
        kind,
      )
      return {
        kind,
        configHash: mcpOperationConfigHashOf(rowToMcp(row)),
      } as ResourceSummaryRevision<K>
    }
    case 'plugin': {
      const row = requireRevisionRow(
        tx.select().from(plugins).where(eq(plugins.id, resourceId)).get(),
        kind,
      )
      return {
        kind,
        configHash: pluginOperationConfigHashOf(rowToPlugin(row)),
      } as ResourceSummaryRevision<K>
    }
    case 'workflow': {
      const row = requireRevisionRow(
        tx
          .select({ version: workflows.version })
          .from(workflows)
          .where(eq(workflows.id, resourceId))
          .get(),
        kind,
      )
      return { kind, version: row.version } as ResourceSummaryRevision<K>
    }
    case 'workgroup': {
      const row = requireRevisionRow(
        tx
          .select({ version: workgroups.version })
          .from(workgroups)
          .where(eq(workgroups.id, resourceId))
          .get(),
        kind,
      )
      return { kind, version: row.version } as ResourceSummaryRevision<K>
    }
  }
}

export const legacyIntentApplyResourceDependencies = Object.freeze({
  prepareAgentCreate,
  getAgentById,
  prepareAgentUpdate,
  commitAgentCreateInTx: (tx: DbTxSync, prepared: unknown) =>
    commitAgentCreateInTx(tx, prepared as PreparedAgentCreate),
  commitAgentUpdateInTx: (tx: DbTxSync, prepared: unknown) =>
    commitAgentUpdateInTx(tx, prepared as PreparedAgentUpdate),
  prepareMcpCreate,
  getMcpById: async (db: DbClient, id: string) => {
    const row = await getMcpById(db, id)
    return row === null ? null : { ...row, ownerUserId: row.ownerUserId ?? null }
  },
  commitMcpCreateInTx: (tx: DbTxSync, prepared: unknown) =>
    commitMcpCreateInTx(tx, prepared as PreparedMcpCreate),
  commitMcpUpdateInTx: (tx: DbTxSync, prepared: unknown) =>
    commitMcpUpdateInTx(tx, prepared as PreparedMcpUpdate),
  getPluginById: getIntentPluginRow,
  pluginOperationConfigHashOf: (row: IntentPluginSnapshot) =>
    pluginOperationConfigHashOf(rowToPlugin(row)),
  commitPluginCreateInTx: (tx: DbTxSync, input: IntentPreparedPluginCreate): void => {
    void commitPluginCreateInTx(tx, input)
  },
  commitPluginPublishInTx: (
    tx: DbTxSync,
    captured: IntentPluginSnapshot,
    input: Parameters<typeof commitPluginPublishInTx>[2],
  ) => commitPluginPublishInTx(tx, captured, input),
  plannedGenerationDir,
  installPlugin,
  stageManagedSkill,
  stageSkillVersion,
  commitSkillReadyInTx,
  commitSkillVersionInTx: (
    tx: DbTxSync,
    staged: StagedSkillVersion,
    commit: Parameters<typeof commitSkillVersionInTx>[2],
  ) => {
    void commitSkillVersionInTx(tx, staged, commit)
  },
  prepareWorkflowSave: (
    db: DbClient,
    id: string,
    input: UpdateWorkflow,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => prepareWorkflowSave(db, id, input, principal),
  insertWorkflowInTx: (tx: DbTxSync, input: Parameters<typeof insertWorkflowInTx>[1]) =>
    insertWorkflowInTx(tx, input),
  commitWorkflowSaveInTx: (tx: DbTxSync, prepared: unknown) =>
    commitWorkflowSaveInTx(tx, prepared as PreparedWorkflowSave),
  broadcastWorkflowCreated: (row: unknown) =>
    broadcastWorkflowCreated(rowToWorkflowDetail(row as WorkflowRow)),
  prepareWorkgroupCreate,
  prepareWorkgroupSave: (
    db: DbClient,
    id: string,
    input: UpdateWorkgroup,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => prepareWorkgroupSave(db, id, input, principal),
  commitWorkgroupCreateInTx: (tx: DbTxSync, prepared: unknown) =>
    commitWorkgroupCreateInTx(tx, prepared as PreparedWorkgroupCreate),
  commitWorkgroupSaveInTx: (tx: DbTxSync, prepared: unknown) =>
    commitWorkgroupSaveInTx(tx, prepared as PreparedWorkgroupSave),
  broadcastWorkgroupCreated: (row: unknown) => broadcastWorkgroupCreated(row as WorkgroupDetail),
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs: (definition: WorkflowDefinition) =>
    extractWorkflowWorkflowRefs(definition),
  extractWorkflowWorkgroupRefs: (definition: WorkflowDefinition) =>
    extractWorkflowWorkgroupRefs(definition),
  resourceRevisionInTx,
  skillOperationState: (db: DbClient, opId: string) =>
    db
      .select({ active: skillOperations.active, phase: skillOperations.phase })
      .from(skillOperations)
      .where(eq(skillOperations.opId, opId))
      .get(),

  // Intent-owned convergence calls these exact legacy effects without reaching
  // back into the six writer modules from applyChangeset.ts.
  compensateManagedSkillStage,
  abortStagedSkillVersion,
  publishStagedSkillVersion,
  unmarkSkillBootVerified,
  finishOperation,
})
