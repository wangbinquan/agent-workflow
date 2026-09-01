import {
  RESOURCE_DISPLAY_NAME_MAX,
  WorkflowDraftSnapshotSchema,
  WorkflowNameSchema,
  migrateWorkflowDefinitionToLatest,
  normalizeResourceDisplayName,
  rehydratePrivilegedNodes,
  type CreateWorkflow,
  type DeleteWorkflow,
  type SaveWorkflowReceipt,
  type UpdateWorkflow,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import { agents, resourceGrants, workflows, workgroups } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import { assertCodeHostAuthorAllowed } from '@/services/codeHostAuthorGate'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'
import { assertScriptAuthorAllowed } from '@/services/scriptAuthorGate'

import { assertNameUnchangedForEditor } from '../application/resourceAccess'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import { hasResourceAclBypass, isVisibleRow, type AclRow } from '../domain/resourceAccess'
import type { WorkflowOperationContext } from '../public/participants'
import {
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from './legacy/resourceRefs'
import type { PostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'
import type { PostgresqlWorkflowPersistenceSemantics } from './postgresqlWorkflowRepository'

interface WorkflowPersistenceEvents {
  created(workflow: Workflow): Promise<void> | void
  updated(receipt: SaveWorkflowReceipt): Promise<void> | void
  deleted(id: string, version: number, input: DeleteWorkflow): Promise<void> | void
}

type ReferenceType = 'agent' | 'workflow' | 'workgroup'

interface ReferenceRow extends AclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

function normalizeCopyBase(value: string): string {
  const normalized = normalizeResourceDisplayName(value).replace(/^[-_]+|[-_]+$/g, '')
  return normalized.length > 0 ? normalized : 'workflow'
}

function copyName(sourceName: string, occupiedNames: Iterable<string>): string {
  const normalized = normalizeCopyBase(sourceName)
  const match = /^(.*)-copy(?:-([2-9][0-9]*))?$/.exec(normalized)
  const base = match === null ? normalized : normalizeCopyBase(match[1] ?? '')
  let sequence = match === null ? 1n : match[2] === undefined ? 2n : BigInt(match[2]) + 1n
  const occupied = new Set(occupiedNames)
  for (;;) {
    const suffix = sequence === 1n ? '-copy' : `-copy-${sequence.toString()}`
    const truncated = [...base]
      .slice(0, RESOURCE_DISPLAY_NAME_MAX - suffix.length)
      .join('')
      .replace(/[-_\s]+$/gu, '')
    const candidate = `${truncated.length > 0 ? truncated : 'workflow'}${suffix}`
    if (!occupied.has(candidate)) return WorkflowNameSchema.parse(candidate)
    sequence += 1n
  }
}

function canonicalDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const migrated = migrateWorkflowDefinitionToLatest(definition)
  const missingAgentNodeIds = (migrated.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)
    .map((node) => node.id)
    .sort()
  if (missingAgentNodeIds.length > 0) {
    throw new ValidationError(
      'workflow-agent-id-required',
      'agent-single nodes require a canonical agentId',
      { nodeIds: missingAgentNodeIds },
    )
  }
  return migrated
}

function referenceGroups(definition: WorkflowDefinition): ReadonlyArray<{
  readonly type: ReferenceType
  readonly domain: 'id' | 'name'
  readonly values: readonly string[]
}> {
  return [
    { type: 'agent', domain: 'id', values: [...extractWorkflowAgentRefs(definition)] },
    { type: 'workflow', domain: 'name', values: extractWorkflowWorkflowRefs(definition) },
    { type: 'workgroup', domain: 'name', values: extractWorkflowWorkgroupRefs(definition) },
  ]
}

async function loadReferenceRows(
  transaction: PostgresqlResourceCatalogTransaction,
  type: ReferenceType,
  domain: 'id' | 'name',
  values: readonly string[],
): Promise<readonly ReferenceRow[]> {
  if (values.length === 0) return []
  const selected = [...new Set(values)]
  switch (type) {
    case 'agent':
      return transaction
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(domain === 'id' ? agents.id : agents.name, selected))
        .all()
    case 'workflow':
      return transaction
        .select({
          id: workflows.id,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(inArray(domain === 'id' ? workflows.id : workflows.name, selected))
        .all()
    case 'workgroup':
      return transaction
        .select({
          id: workgroups.id,
          name: workgroups.name,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(inArray(domain === 'id' ? workgroups.id : workgroups.name, selected))
        .all()
  }
}

async function grantedIds(
  transaction: PostgresqlResourceCatalogTransaction,
  authority: WorkflowOperationContext,
  type: ReferenceType,
): Promise<ReadonlySet<string>> {
  if (hasResourceAclBypass(authority)) return new Set()
  const rows = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, authority.user.id)))
    .all()
  return new Set(rows.map((row) => row.resourceId))
}

async function assertDefinitionReferences(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly authority: WorkflowOperationContext
  readonly definition: WorkflowDefinition
  readonly previous?: WorkflowDefinition
}): Promise<void> {
  const previous = new Map(
    (input.previous === undefined ? [] : referenceGroups(input.previous)).map((group) => [
      `${group.type}:${group.domain}`,
      new Set(group.values),
    ]),
  )
  const missing: Array<{ readonly type: ReferenceType; readonly name: string }> = []
  for (const group of referenceGroups(input.definition)) {
    const grandfathered = previous.get(`${group.type}:${group.domain}`) ?? new Set<string>()
    const values = [...new Set(group.values)].filter((value) => !grandfathered.has(value))
    if (values.length === 0) continue
    const [rows, grants] = await Promise.all([
      loadReferenceRows(input.transaction, group.type, group.domain, values),
      grantedIds(input.transaction, input.authority, group.type),
    ])
    if (group.domain === 'id') {
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const value of values) {
        const row = byId.get(value)
        if (row !== undefined && !isVisibleRow(input.authority, row, grants)) {
          missing.push({ type: group.type, name: value })
        }
      }
      continue
    }
    const byName = new Map<string, ReferenceRow[]>()
    for (const row of rows) {
      const bucket = byName.get(row.name) ?? []
      bucket.push(row)
      byName.set(row.name, bucket)
    }
    for (const value of values) {
      const matches = byName.get(value)
      if (
        matches !== undefined &&
        !matches.some((row) => isVisibleRow(input.authority, row, grants))
      ) {
        missing.push({ type: group.type, name: value })
      }
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${missing.map((entry) => `${entry.type} '${entry.name}'`).join(', ')}`,
      { missing },
    )
  }
}

async function assertNotCalledByWorkflow(
  transaction: PostgresqlResourceCatalogTransaction,
  current: Workflow,
): Promise<void> {
  const rows = await transaction
    .select({ id: workflows.id, definition: workflows.definition })
    .from(workflows)
    .all()
  const caller = rows.find((row) => {
    if (row.id === current.id) return false
    try {
      const parsed: unknown = JSON.parse(row.definition)
      if (typeof parsed !== 'object' || parsed === null) return false
      return extractWorkflowWorkflowRefs(parsed as WorkflowDefinition).includes(current.name)
    } catch {
      return false
    }
  })
  if (caller !== undefined) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${current.id}' is referenced by another workflow`,
    )
  }
}

/** Owner-native semantics for the PostgreSQL Workflow repository. */
export function createPostgresqlWorkflowPersistenceSemantics(input: {
  readonly authorization: ResourceAuthorizationApplication
  readonly events?: WorkflowPersistenceEvents
}): PostgresqlWorkflowPersistenceSemantics {
  return Object.freeze<PostgresqlWorkflowPersistenceSemantics>({
    async canonicalizeCreate(authority, submitted): Promise<CreateWorkflow> {
      const definition = canonicalDefinition(submitted.definition)
      assertScriptAuthorAllowed({
        next: definition,
        principal: { kind: 'actor', actor: authority },
      })
      assertCodeHostAuthorAllowed({
        next: definition,
        principal: { kind: 'actor', actor: authority },
      })
      return Object.freeze({
        ...submitted,
        name: WorkflowNameSchema.parse(submitted.name),
        definition,
      })
    },
    async assertCreateInTransaction(transaction, authority, candidate) {
      await assertDefinitionReferences({
        transaction,
        authority,
        definition: candidate.definition,
      })
    },
    async copyNameAndAssertInTransaction(transaction, authority, source) {
      await assertDefinitionReferences({ transaction, authority, definition: source.definition })
      const occupied = await transaction
        .select({ name: workflows.name })
        .from(workflows)
        .where(eq(workflows.ownerUserId, authority.user.id))
        .all()
      return copyName(
        source.name,
        occupied.map((row) => row.name),
      )
    },
    async canonicalizeUpdate(
      authority,
      current,
      submitted: UpdateWorkflow,
    ): Promise<WorkflowDraftSnapshot> {
      const name = normalizeResourceDisplayName(submitted.snapshot.name)
      const submittedDefinition = canonicalDefinition(submitted.snapshot.definition)
      const definition = rehydratePrivilegedNodes(
        submittedDefinition,
        current.definition,
        privilegedNodeLensFor(authority),
      )
      const access = await input.authorization.resolveResourceAccessFor(
        authority,
        'workflow',
        current,
      )
      assertNameUnchangedForEditor(access, current.name, name)
      assertScriptAuthorAllowed({
        next: definition,
        previous: current.definition,
        principal: { kind: 'actor', actor: authority },
      })
      assertCodeHostAuthorAllowed({
        next: definition,
        previous: current.definition,
        principal: { kind: 'actor', actor: authority },
      })
      return WorkflowDraftSnapshotSchema.parse({
        ...submitted.snapshot,
        name,
        definition,
      })
    },
    async assertUpdateInTransaction(transaction, authority, current, candidate) {
      await assertDefinitionReferences({
        transaction,
        authority,
        definition: candidate.definition,
        previous: current.definition,
      })
    },
    async assertDeleteInTransaction(transaction, _authority, current) {
      await assertNotCalledByWorkflow(transaction, current)
    },
    created: input.events?.created,
    updated: input.events?.updated,
    deleted: input.events?.deleted,
  })
}
